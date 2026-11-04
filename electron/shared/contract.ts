// Contract between the Electron main process, the preload scripts and the renderer (shell UI).
// Pure types and constants: importable from main, preload and renderer code alike.
//
// Process model (mirrors the Tauri design it replaces, ARCHITECTURE §14):
//   - `shell`  renderer: our own UI (terminal, toolbars, dividers). Preload `electron/preload/shell.ts`
//              exposes `window.launcher` (ShellApi). Only this webContents may call SHELL_CHANNELS.
//   - `game`   WebContentsView: https://builderwars.ai (configurable). Preload `electron/preload/game.ts`
//              defines `window.builderwarsLauncher` (the site bridge, see src/bridge.ts) ONLY when the
//              frame origin is the configured site origin. Main re-checks `senderFrame` on every call.
//   - `xpane`  WebContentsView: https://x.com. No preload, no injected script, never read, never
//              automated. Only loadURL / goBack / reload / bounds / lifecycle events.
//   - sign-in popups opened by the game or X pane (Google, Apple, X OAuth) are real Chromium child
//              windows sharing the pane's session, so `window.opener` and the usual OAuth hand-back work.

export type LauncherPlatform = "linux" | "macos" | "windows";
export type ChildPane = "game" | "xpane";
export type FocusTarget = "terminal" | ChildPane;
export type PtyMode = "shell" | "herdr";

export interface EnvInfo {
  platform: LauncherPlatform;
  shell: string;
  /** Agent CLIs found on PATH, in AGENT detection order (see src/agents.ts). */
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

export const DEFAULT_SETTINGS: Settings = {
  defaultAgent: null,
  useHerdr: null,
  grokUrl: "https://x.com/i/grok",
  siteUrl: "https://builderwars.ai",
  workDir: null,
};

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

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HerdrDispatch {
  paneId: string;
  split: boolean;
}

export interface DeepLinkRequest {
  prompt: string;
  agent: string | null;
}

export interface RunPromptEvent {
  id: number;
  prompt: string;
  agent: string | null;
}

export interface PaneLoadEvent {
  pane: ChildPane;
  url: string;
  phase: "started" | "finished";
}

export interface PaneTitleEvent {
  pane: ChildPane;
  title: string;
}

/** Must match MAX_PROMPT_CHARS in src/bridge.ts. */
export const MAX_PROMPT_CHARS = 16_000;
/** Generous: the shell asks the player to confirm before anything runs. */
export const RUN_PROMPT_ANSWER_TIMEOUT_MS = 300_000;
export const HERDR_SESSION = "builderwars";
export const DEEP_LINK_SCHEME = "builderwars";

/** Renderer -> main (shell only). Main rejects calls from any other webContents. */
export const SHELL_CHANNELS = {
  launcherInfo: "launcher:info",
  debugLog: "launcher:debug-log",
  settingsSet: "settings:set",
  ptySpawn: "pty:spawn",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyKill: "pty:kill",
  ptyIsIdle: "pty:is-idle",
  herdrDispatch: "herdr:dispatch",
  paneBounds: "pane:bounds",
  paneNav: "pane:nav",
  paneFocus: "pane:focus",
  pickWorkDir: "dialog:pick-work-dir",
  deeplinkTake: "deeplink:take",
  bridgeResolve: "bridge:resolve",
} as const;

/** Game view -> main (site origin only; the preload only defines the API on that origin and main re-checks). */
export const BRIDGE_CHANNELS = {
  runPrompt: "bridge:run-prompt",
  openX: "bridge:open-x",
} as const;

/** Main -> shell renderer events (payload types below). */
export const SHELL_EVENTS = {
  ptyEvent: "pty:event", // { id: number; event: PtyEvent }
  bridgeRunPrompt: "bridge:run-prompt-request", // RunPromptEvent
  bridgeExpired: "bridge:expired", // number (id)
  deeplinkPending: "deeplink:pending", // undefined
  notice: "launcher:notice", // string
  paneLoad: "pane:load", // PaneLoadEvent
  paneTitle: "pane:title", // PaneTitleEvent
  paneReveal: "pane:reveal", // ChildPane
  focusCycle: "focus:cycle", // undefined
} as const;

export type ShellEventName = (typeof SHELL_EVENTS)[keyof typeof SHELL_EVENTS];

export interface ShellEventPayloads {
  [SHELL_EVENTS.ptyEvent]: { id: number; event: PtyEvent };
  [SHELL_EVENTS.bridgeRunPrompt]: RunPromptEvent;
  [SHELL_EVENTS.bridgeExpired]: number;
  [SHELL_EVENTS.deeplinkPending]: undefined;
  [SHELL_EVENTS.notice]: string;
  [SHELL_EVENTS.paneLoad]: PaneLoadEvent;
  [SHELL_EVENTS.paneTitle]: PaneTitleEvent;
  [SHELL_EVENTS.paneReveal]: ChildPane;
  [SHELL_EVENTS.focusCycle]: undefined;
}

/** What `electron/preload/shell.ts` exposes as `window.launcher`. */
export interface ShellApi {
  launcherInfo(): Promise<LauncherInfo>;
  debugLog(msg: string): Promise<void>;
  settingsSet(settings: Settings): Promise<void>;
  ptySpawn(mode: PtyMode, cols: number, rows: number): Promise<number>;
  ptyWrite(id: number, data: string): Promise<void>;
  ptyResize(id: number, cols: number, rows: number): Promise<void>;
  ptyKill(id: number): Promise<void>;
  ptyIsIdle(id: number): Promise<boolean>;
  herdrDispatch(command: string): Promise<HerdrDispatch>;
  paneBounds(pane: ChildPane, rect: PaneRect, visible: boolean): Promise<void>;
  paneNav(pane: ChildPane, action: "back" | "reload" | "go", url?: string | null): Promise<void>;
  paneFocus(pane: FocusTarget): Promise<void>;
  pickWorkDir(): Promise<string | null>;
  deeplinkTake(): Promise<DeepLinkRequest[]>;
  bridgeResolve(id: number, ok: boolean, value: string): Promise<void>;
  /** Subscribe to a main-process event; returns an unsubscribe function. */
  on<E extends ShellEventName>(event: E, handler: (payload: ShellEventPayloads[E]) => void): () => void;
}

/** Config handed to the game preload (via `additionalArguments`, see electron/preload/game.ts). */
export interface GameBridgeConfig {
  origin: string;
  platform: LauncherPlatform;
  agents: string[];
  defaultAgent: string | null;
  herdr: boolean;
}

export const GAME_BRIDGE_ARG = "--bw-bridge-config=";

declare global {
  interface Window {
    launcher: ShellApi;
  }
}
