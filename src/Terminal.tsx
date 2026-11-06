import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { ptyIsIdle, ptyKill, ptyResize, ptySpawn, ptyWrite, type PtyMode } from "./ipc";
import { TERMINAL_MIN_CONTRAST, TERMINAL_THEMES, type ThemeId } from "./themes";

export interface TerminalHandle {
  /** Type a command line + Enter into the PTY. */
  type(commandLine: string): Promise<void>;
  isIdle(): Promise<boolean>;
  focus(): void;
}

interface Props {
  mode: PtyMode;
  visible: boolean;
  theme: ThemeId;
  onFocus?: () => void;
}

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal({ mode, visible, theme, onFocus }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ptyId = useRef<number | null>(null);
  const exited = useRef(false);
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  // Read once when the terminal is created; later theme changes are applied below without respawning the PTY.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useImperativeHandle(ref, () => ({
    async type(line: string) {
      if (ptyId.current == null) throw new Error("terminal not ready");
      await ptyWrite(ptyId.current, `${line}\r`);
    },
    async isIdle() {
      return ptyId.current != null && !exited.current ? ptyIsIdle(ptyId.current) : false;
    },
    focus() {
      term.current?.focus();
    },
  }));

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = new XTerm({
      theme: TERMINAL_THEMES[themeRef.current],
      minimumContrastRatio: TERMINAL_MIN_CONTRAST[themeRef.current],
      fontFamily: '"JetBrains Mono", "JetBrainsMono Nerd Font", "Fira Code", ui-monospace, monospace',
      fontSize: 13,
      cursorBlink: false, // a blinking cursor keeps the webview repainting (idle CPU)
      scrollback: 5000,
      allowProposedApi: false,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    term.current = t;
    fit.current = f;
    let disposed = false;
    let id: number | null = null;

    const spawn = async () => {
      try {
        f.fit();
      } catch {
        /* not laid out yet */
      }
      exited.current = false;
      id = await ptySpawn(mode, t.cols, t.rows, (e) => {
        if (disposed) return; // a PTY from a previous mount (React StrictMode) being torn down
        if (e.kind === "data") t.write(e.data);
        else {
          exited.current = true;
          t.write(`\r\n\x1b[33m[process exited${e.code != null ? ` (${e.code})` : ""}; press Enter to restart]\x1b[0m\r\n`);
        }
      });
      if (disposed) {
        void ptyKill(id);
        return;
      }
      ptyId.current = id;
    };
    void spawn().catch((err: unknown) => t.write(`\x1b[31mcould not start terminal: ${String(err)}\x1b[0m\r\n`));

    const dataSub = t.onData((d) => {
      if (exited.current) {
        if (d === "\r") void spawn();
        return;
      }
      if (ptyId.current != null) void ptyWrite(ptyId.current, d);
    });
    const resizeSub = t.onResize(({ cols, rows }) => {
      if (ptyId.current != null && !exited.current) void ptyResize(ptyId.current, cols, rows);
    });
    const focusIn = () => onFocusRef.current?.();
    t.textarea?.addEventListener("focus", focusIn);

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
          try {
            f.fit();
          } catch {
            /* ignore */
          }
        }
      });
    });
    ro.observe(el);

    return () => {
      disposed = true;
      ro.disconnect();
      cancelAnimationFrame(raf);
      dataSub.dispose();
      resizeSub.dispose();
      t.textarea?.removeEventListener("focus", focusIn);
      if (id != null) void ptyKill(id);
      ptyId.current = null;
      t.dispose();
    };
  }, [mode]);

  useEffect(() => {
    if (!term.current) return;
    term.current.options.theme = TERMINAL_THEMES[theme];
    term.current.options.minimumContrastRatio = TERMINAL_MIN_CONTRAST[theme];
  }, [theme]);

  useEffect(() => {
    if (visible) {
      try {
        fit.current?.fit();
      } catch {
        /* ignore */
      }
    }
  }, [visible]);

  return <div className="term-host" ref={host} style={{ visibility: visible ? "visible" : "hidden" }} />;
});
