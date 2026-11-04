// Ported from the Tauri bridge init-script tests (src/bridge.test.ts, bridge_init.js): the game
// preload must define the bridge only on the site origin, in the top frame, with the given config.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuilderwarsLauncherApi } from "../../src/bridge";
import { BRIDGE_CHANNELS, GAME_BRIDGE_ARG } from "../shared/contract";

const CFG = { origin: "https://builderwars.ai", platform: "linux", agents: ["claude", "codex"], defaultAgent: "claude", herdr: true };
const savedArgv = process.argv;

async function load(pageOrigin: string, opts: { cfg?: object | null; top?: "self" | "other"; invoke?: ReturnType<typeof vi.fn> } = {}) {
  const exposed: Record<string, unknown> = {};
  const invoke = opts.invoke ?? vi.fn();
  vi.resetModules();
  vi.doMock("electron", () => ({
    contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = Object.freeze(v)) },
    ipcRenderer: { invoke },
  }));
  const win: Record<string, unknown> = { location: { origin: pageOrigin } };
  win.top = opts.top === "other" ? {} : win;
  vi.stubGlobal("window", win);
  const cfg = opts.cfg === undefined ? CFG : opts.cfg;
  process.argv = ["electron", "--type=renderer", ...(cfg ? [GAME_BRIDGE_ARG + JSON.stringify(cfg)] : [])];
  await import("./game");
  return { api: exposed.builderwarsLauncher as BuilderwarsLauncherApi | undefined, exposed, invoke };
}

afterEach(() => {
  process.argv = savedArgv;
  vi.unstubAllGlobals();
  vi.doUnmock("electron");
});

describe("game preload bridge", () => {
  it("defines builderwarsLauncher on the site origin", async () => {
    const invoke = vi.fn().mockResolvedValue({ agent: "claude" });
    const { api, exposed } = await load("https://builderwars.ai", { invoke });
    expect(Object.keys(exposed)).toEqual(["builderwarsLauncher"]);
    expect(api?.version).toBe(1);
    expect(api?.agents).toEqual(["claude", "codex"]);
    expect(api?.defaultAgent).toBe("claude");
    expect(api?.herdr).toBe(true);
    expect(api?.platform).toBe("linux");
    await expect(api!.runPrompt('say "hi"')).resolves.toEqual({ agent: "claude" });
    expect(invoke).toHaveBeenCalledWith(BRIDGE_CHANNELS.runPrompt, 'say "hi"', null);
    expect(Object.isFrozen(api)).toBe(true);
  });

  it("does nothing on another origin (e.g. x.com during OAuth)", async () => {
    const { api } = await load("https://x.com");
    expect(api).toBeUndefined();
  });

  it("does nothing in subframes", async () => {
    const { api } = await load("https://builderwars.ai", { top: "other" });
    expect(api).toBeUndefined();
  });

  it("rejects with an Error carrying the plain launcher message", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("Error invoking remote method 'bridge:run-prompt': Error: terminal is busy"));
    const { api } = await load("https://builderwars.ai", { invoke });
    await expect(api!.runPrompt("x", "codex")).rejects.toThrow(/^terminal is busy$/);
    expect(invoke).toHaveBeenLastCalledWith(BRIDGE_CHANNELS.runPrompt, "x", "codex");
    await expect(api!.openX("https://x.com/i/grok")).rejects.toBeInstanceOf(Error);
    expect(invoke).toHaveBeenLastCalledWith(BRIDGE_CHANNELS.openX, "https://x.com/i/grok");
  });

  it("openX resolves to undefined and passes null without a URL", async () => {
    const invoke = vi.fn().mockResolvedValue("ignored");
    const { api } = await load("https://builderwars.ai", { invoke });
    await expect(api!.openX()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith(BRIDGE_CHANNELS.openX, null);
  });

  it("is a no-op without config", async () => {
    const { api } = await load("https://builderwars.ai", { cfg: null });
    expect(api).toBeUndefined();
  });
});
