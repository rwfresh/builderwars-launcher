// Update banner logic for the shell (state comes from electron/main/updater.ts as update:state events).
import { z } from "zod";
import type { UpdateMode, UpdateState } from "../electron/shared/contract";

const version = z.string().min(1).max(64);

/** Validates update:state payloads from the main process. */
export const updateStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("checking") }),
  z.object({ kind: z.literal("available"), version }),
  z.object({ kind: z.literal("downloading"), version, percent: z.number().min(0).max(100) }),
  z.object({ kind: z.literal("ready"), version }),
  z.object({ kind: z.literal("up-to-date"), version }),
  z.object({ kind: z.literal("error"), message: z.string().max(1000) }),
]);

export function parseUpdateState(payload: unknown): UpdateState | null {
  const r = updateStateSchema.safeParse(payload);
  return r.success ? r.data : null;
}

export type UpdateAction = "restart" | "later" | "download" | "dismiss";

export interface UpdateBanner {
  text: string;
  actions: UpdateAction[];
  /** Quiet styling (progress, checking) instead of the amber call to action. */
  subtle: boolean;
}

/**
 * What the banner shows for a state, or null for nothing. `laterVersion` is the ready version the player put off
 * with LATER (hidden until the next launch; auto mode installs it on quit anyway). `dismissed` is a state the
 * player closed with OK.
 */
export function updateBanner(state: UpdateState, laterVersion: string | null, dismissed: UpdateState | null): UpdateBanner | null {
  if (dismissed != null && JSON.stringify(dismissed) === JSON.stringify(state)) return null;
  switch (state.kind) {
    case "idle":
      return null;
    case "checking":
      return { text: "Checking for updates…", actions: [], subtle: true };
    case "available":
      return { text: `Builder Wars ${state.version} is available.`, actions: ["download"], subtle: false };
    case "downloading":
      return { text: `Downloading Builder Wars ${state.version}… ${state.percent}%`, actions: [], subtle: true };
    case "ready":
      return state.version === laterVersion ? null : { text: `Builder Wars ${state.version} is ready.`, actions: ["restart", "later"], subtle: false };
    case "up-to-date":
      return { text: `You're on the latest version (${state.version}).`, actions: ["dismiss"], subtle: true };
    case "error":
      return { text: `Update check failed: ${state.message}`, actions: ["dismiss"], subtle: false };
  }
}

export const UPDATE_MODE_LABELS: Record<UpdateMode, string> = {
  auto: "installed automatically (downloads in the background, installs on restart)",
  notify: "you're told when a new version is out (deb/rpm installs are never run by the app)",
  off: "off in development builds",
};
