// `builderwars://run?prompt=...&agent=...` deep links (port of deeplink.rs). Pure parsing + queue.
//
// Any web page can open a deep link, so a link never runs anything by itself: it is queued here
// and the shell UI always asks for confirmation (same dialog as prompts from the site).
// Links can arrive before the shell UI listens (cold start), hence the queue + `deeplinkTake`.

import { DEEP_LINK_SCHEME, type DeepLinkRequest } from "../shared/contract";
import { validateAgent, validatePrompt } from "./validate";

export function parseDeepLink(raw: string): DeepLinkRequest {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid deep link");
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) throw new Error(`not a ${DEEP_LINK_SCHEME}:// link`);
  // builderwars://run?... parses with host "run"; also accept builderwars:run?... / builderwars:///run?...
  const action = url.hostname !== "" ? url.hostname : url.pathname.replace(/^\/+|\/+$/g, "");
  if (action !== "run") throw new Error(`unknown deep link action ${JSON.stringify(action)}`);
  let prompt: string | null = null;
  let agent: string | null = null;
  for (const [k, v] of url.searchParams) {
    if (k === "prompt") prompt = v;
    else if (k === "agent" && v !== "") agent = v;
  }
  if (prompt == null) throw new Error("deep link without prompt");
  validatePrompt(prompt);
  if (agent != null) validateAgent(agent);
  return { prompt, agent };
}

/** argv entries that look like deep links (Linux/Windows hand the URL to the app as an argument). */
export function deepLinksInArgv(argv: readonly string[]): string[] {
  return argv.filter((a) => a.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`));
}

export class DeepLinkQueue {
  private items: DeepLinkRequest[] = [];

  /** Parses each URL; returns how many were queued and the errors of the ignored ones. */
  add(urls: readonly string[]): { queued: DeepLinkRequest[]; errors: string[] } {
    const queued: DeepLinkRequest[] = [];
    const errors: string[] = [];
    for (const u of urls) {
      try {
        const req = parseDeepLink(u);
        this.items.push(req);
        queued.push(req);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { queued, errors };
  }

  take(): DeepLinkRequest[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}
