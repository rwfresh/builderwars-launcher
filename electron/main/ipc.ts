// IPC authorization + payload validation helpers for the main process.

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { z } from "zod";

/** Shell-only channel: the sender must be the shell renderer's webContents. */
export function handleShell<T extends z.ZodTuple>(
  channel: string,
  args: T,
  shell: () => WebContents | null,
  fn: (...a: z.infer<T>) => unknown,
): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
    const wc = shell();
    if (!wc || event.sender.id !== wc.id) throw new Error("not allowed");
    const r = args.safeParse(raw);
    if (!r.success) throw new Error(`invalid arguments for ${channel}`);
    return fn(...(r.data as z.infer<T>));
  });
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Bridge channel: the sender must be the game view's webContents, from its top frame, while that
 * frame is on the configured site origin. (The preload only defines the API there; this re-checks.)
 */
export function handleBridge<T extends z.ZodTuple>(
  channel: string,
  args: T,
  game: () => WebContents | null,
  siteOrigin: string,
  fn: (...a: z.infer<T>) => unknown,
): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
    const wc = game();
    const frame = event.senderFrame;
    if (!wc || event.sender.id !== wc.id || !frame || frame.parent !== null) throw new Error("bridge not available here");
    if (originOf(frame.url) !== siteOrigin) throw new Error("bridge not available on this origin");
    const r = args.safeParse(raw);
    if (!r.success) throw new Error("invalid arguments");
    return fn(...(r.data as z.infer<T>));
  });
}

export const paneArg = z.enum(["game", "xpane", "x"]).transform((p) => (p === "x" ? "xpane" : p));
export const rectArg = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export const idArg = z.number().int().nonnegative();
export const dimArg = z
  .number()
  .finite()
  .transform((n) => Math.min(1000, Math.max(2, Math.floor(n))));
