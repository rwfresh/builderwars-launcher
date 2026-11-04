import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { isXUrl, parseRunPromptEvent, parseSiteUrl, type BuilderwarsLauncherApi } from "./bridge";

const INIT_JS = readFileSync(fileURLToPath(new URL("../src-tauri/src/bridge_init.js", import.meta.url)), "utf8");

type FakeWindow = Record<string, unknown> & { top?: unknown; location: { origin: string } };

function runInit(origin: string, pageOrigin: string, invoke = vi.fn()) {
  const cfg = { origin, platform: "linux", agents: ["claude", "codex"], defaultAgent: "claude", herdr: true };
  const src = INIT_JS.replace("/*BW_CONFIG*/ null", JSON.stringify(cfg));
  const win: FakeWindow = { location: { origin: pageOrigin }, __TAURI_INTERNALS__: { invoke } };
  win.top = win;
  // The script only touches `window`; run it with a fake one.
  new Function("window", src)(win);
  return { win, invoke };
}

describe("bridge init script", () => {
  it("defines builderwarsLauncher on the site origin", async () => {
    const invoke = vi.fn().mockResolvedValue({ agent: "claude" });
    const { win } = runInit("https://builderwars.ai", "https://builderwars.ai", invoke);
    const api = win.builderwarsLauncher as BuilderwarsLauncherApi;
    expect(api.version).toBe(1);
    expect(api.agents).toEqual(["claude", "codex"]);
    expect(api.defaultAgent).toBe("claude");
    expect(api.herdr).toBe(true);
    await expect(api.runPrompt('say "hi"')).resolves.toEqual({ agent: "claude" });
    expect(invoke).toHaveBeenCalledWith("run_prompt", { prompt: 'say "hi"', agent: null });
    expect(Object.isFrozen(api)).toBe(true);
  });

  it("does nothing on another origin (e.g. x.com during OAuth)", () => {
    const { win } = runInit("https://builderwars.ai", "https://x.com");
    expect(win.builderwarsLauncher).toBeUndefined();
  });

  it("does nothing in subframes", () => {
    const cfg = { origin: "https://builderwars.ai", platform: "linux", agents: [], defaultAgent: null, herdr: false };
    const win: FakeWindow = { location: { origin: "https://builderwars.ai" }, top: {} };
    new Function("window", INIT_JS.replace("/*BW_CONFIG*/ null", JSON.stringify(cfg)))(win);
    expect(win.builderwarsLauncher).toBeUndefined();
  });

  it("rejects with an Error carrying the launcher message", async () => {
    const invoke = vi.fn().mockRejectedValue("terminal is busy");
    const { win } = runInit("https://builderwars.ai", "https://builderwars.ai", invoke);
    const api = win.builderwarsLauncher as BuilderwarsLauncherApi;
    await expect(api.runPrompt("x", "codex")).rejects.toThrow("terminal is busy");
    await expect(api.openX("https://x.com/i/grok")).rejects.toBeInstanceOf(Error);
    expect(invoke).toHaveBeenLastCalledWith("open_x", { url: "https://x.com/i/grok" });
  });

  it("is a no-op without config (unsubstituted file)", () => {
    const win: FakeWindow = { location: { origin: "https://builderwars.ai" } };
    win.top = win;
    new Function("window", INIT_JS)(win);
    expect(win.builderwarsLauncher).toBeUndefined();
  });
});

describe("bridge payload parsing", () => {
  it("parses run-prompt events from Rust", () => {
    expect(parseRunPromptEvent({ id: 1, prompt: "hi", agent: null })).toEqual({ id: 1, prompt: "hi", agent: null });
    expect(parseRunPromptEvent({ id: 2, prompt: "hi" })).toEqual({ id: 2, prompt: "hi" });
    expect(parseRunPromptEvent({ id: -1, prompt: "hi" })).toBeNull();
    expect(parseRunPromptEvent({ id: 1, prompt: "" })).toBeNull();
    expect(parseRunPromptEvent("nope")).toBeNull();
  });

  it("only accepts https x.com URLs for the X pane", () => {
    expect(isXUrl("https://x.com/i/grok")).toBe(true);
    expect(isXUrl("https://mobile.twitter.com/a")).toBe(true);
    expect(isXUrl("http://x.com/")).toBe(false);
    expect(isXUrl("https://x.com.evil.example/")).toBe(false);
    expect(isXUrl("https://evilx.com/")).toBe(false);
    expect(isXUrl("javascript:alert(1)")).toBe(false);
  });

  it("normalises site URLs", () => {
    expect(parseSiteUrl("https://builderwars.ai/")).toEqual({ base: "https://builderwars.ai", origin: "https://builderwars.ai" });
    expect(parseSiteUrl("http://localhost:3000")).toEqual({ base: "http://localhost:3000", origin: "http://localhost:3000" });
    expect(parseSiteUrl("file:///etc/passwd")).toBeNull();
  });
});
