// Typed wrappers over the shell-only Tauri commands.
import { Channel, invoke } from "@tauri-apps/api/core";

export interface EnvInfo {
  platform: "linux" | "macos" | "windows";
  shell: string;
  agents: string[];
  herdr: boolean;
}

export interface Settings {
  defaultAgent: string | null;
  useHerdr: boolean | null;
  grokUrl: string;
  siteUrl: string;
  /** null = default (~/BuilderWars). */
  workDir: string | null;
}

export interface LauncherInfo {
  env: EnvInfo;
  settings: Settings;
  siteUrl: string;
  siteOrigin: string;
  /** Resolved, existing work directory. */
  workDir: string;
  home: string;
  autotest: boolean;
}

export type PtyEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null };
export type PtyMode = "shell" | "herdr";
export type ChildPane = "game" | "xpane";

export const debugLog = (msg: string) => invoke<void>("debug_log", { msg }).catch(() => {});
export const launcherInfo = () => invoke<LauncherInfo>("launcher_info");
export const saveSettings = (settings: Settings) => invoke<void>("settings_set", { settings });

export function ptySpawn(mode: PtyMode, cols: number, rows: number, onEvent: (e: PtyEvent) => void) {
  const ch = new Channel<PtyEvent>();
  ch.onmessage = onEvent;
  return invoke<number>("pty_spawn", { mode, cols, rows, onEvent: ch });
}
export const ptyWrite = (id: number, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows });
export const ptyKill = (id: number) => invoke<void>("pty_kill", { id });
export const ptyIsIdle = (id: number) => invoke<boolean>("pty_is_idle", { id });
export const herdrDispatch = (command: string) =>
  invoke<{ paneId: string; split: boolean }>("herdr_dispatch", { command });

export const paneBounds = (pane: ChildPane, r: { x: number; y: number; width: number; height: number }, visible: boolean) =>
  invoke<void>("pane_bounds", {
    pane,
    ...r,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    visible,
  });
export const paneNav = (pane: ChildPane, action: "back" | "reload" | "go", url?: string) =>
  invoke<void>("pane_nav", { pane, action, url: url ?? null });
export const paneFocus = (pane: "terminal" | ChildPane) => invoke<void>("pane_focus", { pane });
export const pickWorkDir = () => invoke<string | null>("pick_work_dir");
export const deeplinkTake = () => invoke<unknown>("deeplink_take");
export const bridgeResolve = (id: number, ok: boolean, value: string) => invoke<void>("bridge_resolve", { id, ok, value });
