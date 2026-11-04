import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { AGENT_LABELS, buildCommand, chooseAgent, isAgentId, shellKindFromPath } from "./agents";
import { isXUrl, paneLoadSchema, paneTitleSchema, parseRunPromptEvent, parseSiteUrl } from "./bridge";
import { ChildPanePlaceholder } from "./ChildPane";
import {
  bridgeResolve,
  debugLog,
  herdrDispatch,
  launcherInfo,
  paneFocus,
  paneNav,
  saveSettings,
  type ChildPane,
  type LauncherInfo,
  type Settings,
} from "./ipc";
import { DEFAULT_LAYOUT, DIVIDER_PX, computeColumns, dragDivider, nextFocus, toggleCollapsed, type LayoutState, type PaneId } from "./layout";
import { Terminal, type TerminalHandle } from "./Terminal";

interface PaneInfo {
  url: string;
  title: string;
  loading: boolean;
}

const X_HOME = "https://x.com/home";

export function App() {
  const [info, setInfo] = useState<LauncherInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    launcherInfo().then(setInfo, (e: unknown) => setError(String(e)));
  }, []);
  if (error) return <div className="boot">launcher error: {error}</div>;
  if (!info) return <div className="boot">BOOTING BUILDER WARS…</div>;
  return <Shell info={info} />;
}

function Shell({ info }: { info: LauncherInfo }) {
  const { env } = info;
  const [settings, setSettings] = useState<Settings>(info.settings);
  const useHerdr = env.herdr && (settings.useHerdr ?? true);
  const shellKind = shellKindFromPath(env.shell);
  const [layout, setLayout] = useState<LayoutState>(DEFAULT_LAYOUT);
  const [width, setWidth] = useState(window.innerWidth);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<string>("ready");
  const [focused, setFocused] = useState<PaneId>("terminal");
  const [panes, setPanes] = useState<Record<ChildPane, PaneInfo>>({
    game: { url: info.siteUrl, title: "", loading: true },
    xpane: { url: X_HOME, title: "", loading: true },
  });
  const [xMode, setXMode] = useState<"home" | "grok">("home");
  const [manualPrompt, setManualPrompt] = useState("");
  const term = useRef<TerminalHandle>(null);
  const defaultAgent = chooseAgent(null, settings.defaultAgent, env.agents);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const cols = computeColumns(width, layout);

  /** Core action: run an agent with an initial prompt in the terminal pane. Returns the agent used. */
  const runPrompt = useCallback(
    async ({ agent, prompt }: { agent?: string | null; prompt: string }): Promise<string> => {
      const choice = chooseAgent(agent, settings.defaultAgent, env.agents);
      if ("error" in choice) throw new Error(choice.error);
      const line = buildCommand(choice.agent, prompt, shellKind);
      if (useHerdr) {
        const r = await herdrDispatch(line);
        setStatus(`${AGENT_LABELS[choice.agent]} started in herdr pane ${r.paneId}${r.split ? " (new split)" : ""}`);
      } else {
        const t = term.current;
        void debugLog(`runPrompt agent=${choice.agent} herdr=${useHerdr} handle=${t ? "yes" : "no"}`);
        if (!t) throw new Error("terminal not ready");
        if (!(await t.isIdle())) throw new Error("the terminal is busy; exit the running program first");
        await t.type(line);
        setStatus(`${AGENT_LABELS[choice.agent]} started in the terminal`);
      }
      setLayout((l) => toggleCollapsed(l, "terminal", false));
      return choice.agent;
    },
    [settings.defaultAgent, env.agents, shellKind, useHerdr],
  );

  const focusPane = useCallback((p: PaneId) => {
    setFocused(p);
    if (p === "terminal") {
      void paneFocus("terminal").then(() => term.current?.focus());
    } else {
      void paneFocus(p);
    }
  }, []);

  // Bridge + pane events from Rust.
  const runPromptRef = useRef(runPrompt);
  runPromptRef.current = runPrompt;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useEffect(() => {
    const unsubs = [
      listen("bridge:run-prompt", (ev) => {
        const req = parseRunPromptEvent(ev.payload);
        if (!req) return;
        setStatus("site asked to run a prompt…");
        runPromptRef.current({ agent: req.agent ?? null, prompt: req.prompt }).then(
          (agent) => bridgeResolve(req.id, true, agent),
          (e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            setStatus(`run prompt failed: ${msg}`);
            return bridgeResolve(req.id, false, msg);
          },
        );
      }),
      listen("pane:load", (ev) => {
        const p = paneLoadSchema.safeParse(ev.payload);
        if (!p.success) return;
        setPanes((s) => ({ ...s, [p.data.pane]: { ...s[p.data.pane], url: p.data.url, loading: p.data.phase === "started" } }));
      }),
      listen("pane:title", (ev) => {
        const p = paneTitleSchema.safeParse(ev.payload);
        if (!p.success) return;
        setPanes((s) => ({ ...s, [p.data.pane]: { ...s[p.data.pane], title: p.data.title } }));
      }),
      listen("pane:reveal", () => setLayout((l) => toggleCollapsed(l, "xpane", false))),
      listen("focus:cycle", () => focusPane(nextFocus(focusedRef.current, layoutRef.current.collapsed))),
    ];
    return () => unsubs.forEach((u) => void u.then((f) => f()));
  }, [focusPane]);

  // F6 / Ctrl+` cycle focus. On Linux, Rust catches F6 at the GTK window level (so it also works
  // while a child webview has focus) and emits focus:cycle; this handler covers the other platforms.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "F6" && env.platform !== "linux") || (e.ctrlKey && e.key === "`")) {
        e.preventDefault();
        focusPane(nextFocus(focusedRef.current, layoutRef.current.collapsed));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [env.platform, focusPane]);

  // Autotest: show the PTY works with a real agent CLI (Rust drives the bridge test separately).
  useEffect(() => {
    if (!info.autotest) return;
    const t = setTimeout(() => {
      const line = "claude --version";
      if (useHerdr) void herdrDispatch(line).then((r) => setStatus(`autotest: ${line} in ${r.paneId}`));
      else {
        void debugLog(`autotest: handle=${term.current ? "yes" : "no"}`);
        void term.current?.type(line).then(
          () => setStatus(`autotest: typed ${line}`),
          (e: unknown) => void debugLog(`autotest type failed: ${String(e)}`),
        );
      }
    }, 3000);
    // Layout exercise: drag the first divider, collapse and re-expand the X pane. The child
    // webview bounds that follow are visible in the launcher log (BW_DEBUG_BOUNDS=1).
    const steps = [
      setTimeout(() => {
        void debugLog("autotest: drag divider 1 by +60px");
        setLayout((l) => dragDivider(l, 1, 60, window.innerWidth));
      }, 22000),
      setTimeout(() => {
        void debugLog("autotest: collapse X");
        setLayout((l) => toggleCollapsed(l, "xpane", true));
      }, 24000),
      setTimeout(() => {
        void debugLog("autotest: expand X");
        setLayout((l) => toggleCollapsed(l, "xpane", false));
      }, 26000),
    ];
    return () => {
      clearTimeout(t);
      steps.forEach(clearTimeout);
    };
  }, [info.autotest, useHerdr]);

  // Divider drag.
  const drag = useRef<{ divider: 0 | 1; startX: number; start: LayoutState } | null>(null);
  const onDividerDown = (divider: 0 | 1) => (e: RPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { divider, startX: e.clientX, start: layout };
    document.body.classList.add("dragging");
  };
  const onDividerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setLayout(dragDivider(d.start, d.divider, e.clientX - d.startX, width));
  };
  const onDividerUp = () => {
    drag.current = null;
    document.body.classList.remove("dragging");
  };

  const collapse = (p: PaneId) => setLayout((l) => toggleCollapsed(l, p));
  const xTarget = xMode === "grok" ? settings.grokUrl : X_HOME;
  const toggleXMode = () => {
    const next = xMode === "home" ? "grok" : "home";
    setXMode(next);
    void paneNav("xpane", "go", next === "grok" ? settings.grokUrl : X_HOME);
  };

  const gridTemplate = `${cols.terminal}px ${DIVIDER_PX}px ${cols.game}px ${DIVIDER_PX}px ${cols.xpane}px`;
  const shortUrl = (u: string) => u.replace(/^https?:\/\//, "").slice(0, 80);

  return (
    <div className="shell" style={{ gridTemplateColumns: gridTemplate }}>
      {/* LEFT: terminal + toolbar */}
      {layout.collapsed.terminal ? (
        <CollapsedStrip label="TERMINAL" onExpand={() => collapse("terminal")} />
      ) : (
        <section className={`col col-left ${focused === "terminal" ? "focused" : ""}`}>
          <header className="pane-head">
            <span className="tag">TERM</span>
            <span className="pane-title">{useHerdr ? "herdr · session builderwars" : env.shell}</span>
            <button className="btn" title="Collapse" onClick={() => collapse("terminal")}>
              ◂
            </button>
          </header>
          <div className="term-wrap">
            <Terminal ref={term} mode={useHerdr ? "herdr" : "shell"} visible={!settingsOpen} onFocus={() => setFocused("terminal")} />
            {settingsOpen && (
              <SettingsPanel
                info={info}
                settings={settings}
                onClose={() => setSettingsOpen(false)}
                onSave={async (s) => {
                  await saveSettings(s);
                  const siteChanged = s.siteUrl !== settings.siteUrl;
                  setSettings(s);
                  setSettingsOpen(false);
                  setStatus(siteChanged ? "saved; restart the launcher to use the new site URL" : "settings saved");
                }}
              />
            )}
          </div>
          <footer className="toolbar">
            <div className="row">
              <label className="field">
                AGENT
                <select
                  value={"agent" in defaultAgent ? defaultAgent.agent : ""}
                  onChange={(e) => {
                    const s = { ...settings, defaultAgent: e.target.value || null };
                    setSettings(s);
                    void saveSettings(s);
                  }}
                >
                  {env.agents.length === 0 && <option value="">none found</option>}
                  {env.agents.filter(isAgentId).map((a) => (
                    <option key={a} value={a}>
                      {AGENT_LABELS[a]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`field check ${env.herdr ? "" : "disabled"}`} title={env.herdr ? "Run the terminal inside herdr" : "herdr not found on PATH"}>
                <input
                  type="checkbox"
                  disabled={!env.herdr}
                  checked={useHerdr}
                  onChange={(e) => {
                    const s = { ...settings, useHerdr: e.target.checked };
                    setSettings(s);
                    void saveSettings(s);
                  }}
                />
                HERDR
              </label>
              <button className="btn" onClick={() => setSettingsOpen((o) => !o)}>
                {settingsOpen ? "CLOSE" : "SETTINGS"}
              </button>
              <button className="btn" title="Cycle focus (F6)" onClick={() => focusPane(nextFocus(focused, layout.collapsed))}>
                F6 ⇄
              </button>
            </div>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (!manualPrompt.trim()) return;
                runPrompt({ prompt: manualPrompt }).then(
                  () => setManualPrompt(""),
                  (err: unknown) => setStatus(`error: ${err instanceof Error ? err.message : String(err)}`),
                );
              }}
            >
              <input className="prompt" placeholder="prompt for your agent…" value={manualPrompt} onChange={(e) => setManualPrompt(e.target.value)} />
              <button className="btn amber" type="submit">
                RUN ▸
              </button>
            </form>
            <div className="status" title={status}>
              ▌{status}
            </div>
          </footer>
        </section>
      )}

      <div className="divider" onPointerDown={onDividerDown(0)} onPointerMove={onDividerMove} onPointerUp={onDividerUp} />

      {/* CENTER: game child webview */}
      {layout.collapsed.game ? (
        <CollapsedStrip label="GAME" onExpand={() => collapse("game")} />
      ) : (
        <section className={`col ${focused === "game" ? "focused" : ""}`}>
          <header className="pane-head">
            <span className="tag">GAME</span>
            <button className="btn" title="Back" onClick={() => void paneNav("game", "back")}>
              ◂
            </button>
            <button className="btn" title="Reload" onClick={() => void paneNav("game", "reload")}>
              ⟳
            </button>
            <button className="btn" title="Dashboard" onClick={() => void paneNav("game", "go", `${info.siteUrl}/dashboard`)}>
              ⌂
            </button>
            <span className="pane-title" title={panes.game.url}>
              {panes.game.loading ? "loading… " : ""}
              {panes.game.title || shortUrl(panes.game.url)}
            </span>
            <button className="btn" title="Collapse" onClick={() => collapse("game")}>
              ▸
            </button>
          </header>
          <ChildPanePlaceholder pane="game" label="builderwars.ai" visible={!layout.collapsed.game} />
        </section>
      )}

      <div className="divider" onPointerDown={onDividerDown(1)} onPointerMove={onDividerMove} onPointerUp={onDividerUp} />

      {/* RIGHT: X child webview */}
      {layout.collapsed.xpane ? (
        <CollapsedStrip label="X" onExpand={() => collapse("xpane")} />
      ) : (
        <section className={`col ${focused === "xpane" ? "focused" : ""}`}>
          <header className="pane-head">
            <span className="tag amber">X</span>
            <button className="btn" title="Back" onClick={() => void paneNav("xpane", "back")}>
              ◂
            </button>
            <button className="btn" title="Reload" onClick={() => void paneNav("xpane", "reload")}>
              ⟳
            </button>
            <button className="btn" title={`Switch to ${xMode === "home" ? "Grok" : "Home"}`} onClick={toggleXMode}>
              {xMode === "home" ? "GROK" : "HOME"}
            </button>
            <span className="pane-title" title={panes.xpane.url}>
              {panes.xpane.loading ? "loading… " : ""}
              {panes.xpane.title || shortUrl(panes.xpane.url || xTarget)}
            </span>
            <button className="btn" title="Collapse" onClick={() => collapse("xpane")}>
              ▸
            </button>
          </header>
          <ChildPanePlaceholder pane="xpane" label="x.com" visible={!layout.collapsed.xpane} />
        </section>
      )}
    </div>
  );
}

function CollapsedStrip({ label, onExpand }: { label: string; onExpand: () => void }) {
  return (
    <button className="strip" onClick={onExpand} title={`Expand ${label}`}>
      <span>{label}</span>
    </button>
  );
}

function SettingsPanel({
  info,
  settings,
  onSave,
  onClose,
}: {
  info: LauncherInfo;
  settings: Settings;
  onSave: (s: Settings) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [err, setErr] = useState<string | null>(null);
  const herdrValue = draft.useHerdr == null ? "auto" : draft.useHerdr ? "on" : "off";
  const valid = useMemo(() => {
    if (!parseSiteUrl(draft.siteUrl)) return "site URL must be http(s)";
    if (!isXUrl(draft.grokUrl)) return "Grok URL must be an https://x.com URL";
    return null;
  }, [draft]);
  return (
    <div className="settings">
      <h2>SETTINGS</h2>
      <label>
        Default agent
        <select value={draft.defaultAgent ?? ""} onChange={(e) => setDraft({ ...draft, defaultAgent: e.target.value || null })}>
          <option value="">first installed</option>
          {info.env.agents.filter(isAgentId).map((a) => (
            <option key={a} value={a}>
              {AGENT_LABELS[a]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Use herdr {info.env.herdr ? "" : "(not installed)"}
        <select
          value={herdrValue}
          disabled={!info.env.herdr}
          onChange={(e) => setDraft({ ...draft, useHerdr: e.target.value === "auto" ? null : e.target.value === "on" })}
        >
          <option value="auto">auto (on when installed)</option>
          <option value="on">on</option>
          <option value="off">off</option>
        </select>
      </label>
      <label>
        Grok chat URL
        <input value={draft.grokUrl} onChange={(e) => setDraft({ ...draft, grokUrl: e.target.value })} />
      </label>
      <label>
        Game site URL (restart to apply; bridge only trusts this origin)
        <input value={draft.siteUrl} onChange={(e) => setDraft({ ...draft, siteUrl: e.target.value })} />
      </label>
      <p className="muted">
        Active site: {info.siteUrl} · agents on PATH: {info.env.agents.join(", ") || "none"} · shell: {info.env.shell}
      </p>
      {(err ?? valid) && <p className="err">{err ?? valid}</p>}
      <div className="row">
        <button
          className="btn amber"
          disabled={valid != null}
          onClick={() => onSave(draft).catch((e: unknown) => setErr(String(e)))}
        >
          SAVE
        </button>
        <button className="btn" onClick={onClose}>
          CANCEL
        </button>
      </div>
    </div>
  );
}
