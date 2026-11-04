// Bridge contract between the game site (https://builderwars.ai, in the `game` WebContentsView) and
// the launcher. The game preload (electron/preload/game.ts) defines `window.builderwarsLauncher` in
// the game view only, and only when the top-level page is on the configured site origin. Calls travel
// over Electron IPC (BRIDGE_CHANNELS in electron/shared/contract.ts); the main process re-checks the
// sender (game view, top frame, site origin), forwards run_prompt to this shell UI as a
// `bridge:run-prompt-request` event (SHELL_EVENTS.bridgeRunPrompt), and the shell answers via bridgeResolve.
import { z } from "zod";

export type LauncherPlatform = "linux" | "macos" | "windows";

/** What the site sees as `window.builderwarsLauncher` (version 1). */
export interface BuilderwarsLauncherApi {
  readonly version: 1;
  readonly platform: LauncherPlatform;
  readonly agents: readonly string[];
  readonly defaultAgent: string | null;
  readonly herdr: boolean;
  /** Types the agent command into the launcher terminal. Rejects with Error(message) on failure. */
  runPrompt(prompt: string, agent?: string | null): Promise<{ agent: string }>;
  /** Shows the X pane, optionally navigating it to an https://x.com URL. */
  openX(url?: string | null): Promise<void>;
}

/** Must match MAX_PROMPT_CHARS in electron/shared/contract.ts (enforced by electron/main/validate.ts). */
export const MAX_PROMPT_CHARS = 16_000;

export const runPromptEventSchema = z.object({
  id: z.number().int().nonnegative(),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS * 2), // code points vs UTF-16 units; main checks code points
  agent: z.string().max(32).nullable().optional(),
});
export type RunPromptEvent = z.infer<typeof runPromptEventSchema>;

export function parseRunPromptEvent(payload: unknown): RunPromptEvent | null {
  const r = runPromptEventSchema.safeParse(payload);
  return r.success ? r.data : null;
}

/** A queued `builderwars://run?prompt=...&agent=...` request (validated in the main process, electron/main/deeplink.ts). */
export const deepLinkRequestSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS * 2),
  agent: z.string().max(32).nullable().optional(),
});
export type DeepLinkRequest = z.infer<typeof deepLinkRequestSchema>;

export function parseDeepLinkRequests(payload: unknown): DeepLinkRequest[] {
  const r = z.array(deepLinkRequestSchema).safeParse(payload);
  return r.success ? r.data : [];
}

export const paneLoadSchema = z.object({
  pane: z.enum(["game", "xpane"]),
  url: z.string(),
  phase: z.enum(["started", "finished"]),
});
export const paneTitleSchema = z.object({ pane: z.enum(["game", "xpane"]), title: z.string() });

/** Same rule as isXHost in electron/main/urls.ts: https and x.com / twitter.com (or subdomains). */
export function isXUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const h = u.hostname;
  return (
    u.protocol === "https:" &&
    (h === "x.com" || h.endsWith(".x.com") || h === "twitter.com" || h.endsWith(".twitter.com"))
  );
}

/** Normalise a site URL setting to {base, origin}; null when not http(s). */
export function parseSiteUrl(raw: string): { base: string; origin: string } | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { base: u.href.replace(/\/+$/, ""), origin: u.origin };
  } catch {
    return null;
  }
}
