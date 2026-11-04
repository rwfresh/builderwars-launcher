// Typed wrappers over the shell-only launcher API (`window.launcher`, exposed by
// electron/preload/shell.ts; channels and types in electron/shared/contract.ts).
import {
  SHELL_EVENTS,
  type ChildPane,
  type DeepLinkRequest,
  type HerdrDispatch,
  type PaneRect,
  type PtyEvent,
  type PtyMode,
  type Settings,
  type ShellEventName,
  type ShellEventPayloads,
} from "../electron/shared/contract";

export type { ChildPane, EnvInfo, LauncherInfo, PtyEvent, PtyMode, Settings } from "../electron/shared/contract";

const api = () => window.launcher;

export const debugLog = (msg: string) => api().debugLog(msg).catch(() => {});
export const launcherInfo = () => api().launcherInfo();
export const saveSettings = (settings: Settings) => api().settingsSet(settings);

/** Subscribe to a main-process event; returns an unsubscribe function. */
export function onLauncherEvent<E extends ShellEventName>(event: E, handler: (payload: ShellEventPayloads[E]) => void): () => void {
  return api().on(event, handler);
}

/**
 * Spawn a PTY and stream its events to `onEvent`. The event subscription is installed before the
 * spawn request is sent, and events that arrive before the id is known are buffered, so no early
 * output is lost. Unsubscribes after the exit event.
 */
export async function ptySpawn(mode: PtyMode, cols: number, rows: number, onEvent: (e: PtyEvent) => void): Promise<number> {
  let id: number | null = null;
  let early: { id: number; event: PtyEvent }[] = [];
  let done = false;
  const deliver = (e: PtyEvent) => {
    if (done) return;
    if (e.kind === "exit") {
      done = true;
      unsubscribe();
    }
    onEvent(e);
  };
  const unsubscribe = onLauncherEvent(SHELL_EVENTS.ptyEvent, (msg) => {
    if (id == null) early.push(msg);
    else if (msg.id === id) deliver(msg.event);
  });
  try {
    id = await api().ptySpawn(mode, cols, rows);
  } catch (e) {
    unsubscribe();
    throw e;
  }
  const buffered = early;
  early = [];
  for (const m of buffered) if (m.id === id) deliver(m.event);
  return id;
}
export const ptyWrite = (id: number, data: string) => api().ptyWrite(id, data);
export const ptyResize = (id: number, cols: number, rows: number) => api().ptyResize(id, cols, rows);
export const ptyKill = (id: number) => api().ptyKill(id);
export const ptyIsIdle = (id: number) => api().ptyIsIdle(id);
export const herdrDispatch = (command: string): Promise<HerdrDispatch> => api().herdrDispatch(command);

/** `r` is in CSS px of the shell viewport, which are the window's DIPs (no scaling needed). */
export const paneBounds = (pane: ChildPane, r: PaneRect, visible: boolean) => api().paneBounds(pane, r, visible);
export const paneNav = (pane: ChildPane, action: "back" | "reload" | "go", url?: string) => api().paneNav(pane, action, url ?? null);
export const paneFocus = (pane: "terminal" | ChildPane) => api().paneFocus(pane);
export const pickWorkDir = () => api().pickWorkDir();
export const deeplinkTake = (): Promise<DeepLinkRequest[]> => api().deeplinkTake();
export const bridgeResolve = (id: number, ok: boolean, value: string) => api().bridgeResolve(id, ok, value);
