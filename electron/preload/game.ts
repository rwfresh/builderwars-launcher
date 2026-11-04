// Preload for the game view (https://builderwars.ai or the configured site). Defines the site
// bridge `window.builderwarsLauncher` (contract: src/bridge.ts, BuilderwarsLauncherApi) and nothing
// else, and ONLY when the top-level document is on the configured site origin: OAuth hops through
// x.com in the same view, and sign-in popups that inherit this preload, get nothing. Main re-checks
// the sender (game view, top frame, site origin) on every call.
// Sandboxed preload: only `electron` is used; contract imports are types plus constants.

import { contextBridge, ipcRenderer } from "electron";
import { BRIDGE_CHANNELS, GAME_BRIDGE_ARG, type GameBridgeConfig } from "../shared/contract";

function readConfig(): GameBridgeConfig | null {
  const arg = process.argv.find((a) => a.startsWith(GAME_BRIDGE_ARG));
  if (!arg) return null;
  try {
    const c = JSON.parse(arg.slice(GAME_BRIDGE_ARG.length)) as Partial<GameBridgeConfig>;
    if (typeof c.origin !== "string" || !Array.isArray(c.agents)) return null;
    return {
      origin: c.origin,
      platform: c.platform === "macos" || c.platform === "windows" ? c.platform : "linux",
      agents: c.agents.filter((a): a is string => typeof a === "string"),
      defaultAgent: typeof c.defaultAgent === "string" ? c.defaultAgent : null,
      herdr: c.herdr === true,
    };
  } catch {
    return null;
  }
}

/** Electron prefixes invoke errors with "Error invoking remote method '<ch>': Error: "; the site sees the plain message. */
function plainError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "") || "launcher request failed");
}

const cfg = readConfig();
if (cfg && window.top === window && window.location.origin === cfg.origin) {
  contextBridge.exposeInMainWorld("builderwarsLauncher", {
    version: 1,
    platform: cfg.platform,
    agents: cfg.agents.slice(),
    defaultAgent: cfg.defaultAgent,
    herdr: cfg.herdr,
    runPrompt(prompt: unknown, agent?: unknown): Promise<{ agent: string }> {
      return (ipcRenderer.invoke(BRIDGE_CHANNELS.runPrompt, String(prompt), agent == null ? null : String(agent)) as Promise<{ agent: string }>).then(
        (r) => ({ agent: String(r.agent) }),
        (e: unknown) => {
          throw plainError(e);
        },
      );
    },
    openX(url?: unknown): Promise<void> {
      return (ipcRenderer.invoke(BRIDGE_CHANNELS.openX, url == null ? null : String(url)) as Promise<unknown>).then(
        () => undefined,
        (e: unknown) => {
          throw plainError(e);
        },
      );
    },
  });
}
