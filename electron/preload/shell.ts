// Preload for the shell renderer (our own UI). Exposes `window.launcher` (ShellApi).
// Sandboxed preload: only `electron` (contextBridge, ipcRenderer) is used; contract imports are
// types plus plain constants, inlined at build time.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { SHELL_CHANNELS, SHELL_EVENTS, type ShellApi, type ShellEventName } from "../shared/contract";

const EVENT_NAMES = new Set<string>(Object.values(SHELL_EVENTS));

/** Electron prefixes invoke errors with "Error invoking remote method '<ch>': Error: "; keep the message. */
function plainError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ""));
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return (ipcRenderer.invoke(channel, ...args) as Promise<T>).catch((e: unknown) => {
    throw plainError(e);
  });
}

const api: ShellApi = {
  launcherInfo: () => invoke(SHELL_CHANNELS.launcherInfo),
  debugLog: (msg) => invoke(SHELL_CHANNELS.debugLog, String(msg)),
  settingsSet: (settings) => invoke(SHELL_CHANNELS.settingsSet, settings),
  ptySpawn: (mode, cols, rows) => invoke(SHELL_CHANNELS.ptySpawn, mode, cols, rows),
  ptyWrite: (id, data) => invoke(SHELL_CHANNELS.ptyWrite, id, data),
  ptyResize: (id, cols, rows) => invoke(SHELL_CHANNELS.ptyResize, id, cols, rows),
  ptyKill: (id) => invoke(SHELL_CHANNELS.ptyKill, id),
  ptyIsIdle: (id) => invoke(SHELL_CHANNELS.ptyIsIdle, id),
  herdrDispatch: (command) => invoke(SHELL_CHANNELS.herdrDispatch, command),
  paneBounds: (pane, rect, visible) =>
    invoke(SHELL_CHANNELS.paneBounds, pane, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, visible),
  paneNav: (pane, action, url) => invoke(SHELL_CHANNELS.paneNav, pane, action, url ?? null),
  paneFocus: (pane) => invoke(SHELL_CHANNELS.paneFocus, pane),
  pickWorkDir: () => invoke(SHELL_CHANNELS.pickWorkDir),
  deeplinkTake: () => invoke(SHELL_CHANNELS.deeplinkTake),
  bridgeResolve: (id, ok, value) => invoke(SHELL_CHANNELS.bridgeResolve, id, ok, value),
  updateCheck: () => invoke(SHELL_CHANNELS.updateCheck),
  updateRestart: () => invoke(SHELL_CHANNELS.updateRestart),
  updateOpenDownload: () => invoke(SHELL_CHANNELS.updateOpenDownload),
  on(event, handler) {
    if (!EVENT_NAMES.has(event)) throw new Error(`unknown launcher event ${String(event)}`);
    const listener = (_e: IpcRendererEvent, payload: unknown) => (handler as (p: unknown) => void)(payload);
    ipcRenderer.on(event as ShellEventName, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  },
};

contextBridge.exposeInMainWorld("launcher", api);
