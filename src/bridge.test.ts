import { describe, expect, it } from "vitest";
import { isXUrl, parseDeepLinkRequests, parseRunPromptEvent, parseSiteUrl } from "./bridge";

// The bridge itself (window.builderwarsLauncher) is tested in electron/preload/game.test.ts.

describe("bridge payload parsing", () => {
  it("parses run-prompt events from the main process", () => {
    expect(parseRunPromptEvent({ id: 1, prompt: "hi", agent: null })).toEqual({ id: 1, prompt: "hi", agent: null });
    expect(parseRunPromptEvent({ id: 2, prompt: "hi" })).toEqual({ id: 2, prompt: "hi" });
    expect(parseRunPromptEvent({ id: -1, prompt: "hi" })).toBeNull();
    expect(parseRunPromptEvent({ id: 1, prompt: "" })).toBeNull();
    expect(parseRunPromptEvent("nope")).toBeNull();
  });

  it("parses queued deep-link requests", () => {
    expect(parseDeepLinkRequests([{ prompt: "hi", agent: "codex" }, { prompt: "yo", agent: null }])).toHaveLength(2);
    expect(parseDeepLinkRequests([{ prompt: "" }])).toEqual([]);
    expect(parseDeepLinkRequests(null)).toEqual([]);
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
