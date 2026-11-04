import { describe, expect, it } from "vitest";
import type { ChildPane } from "../shared/contract";
import { classifyNewWindow, hasPopupFeatures, hostForLog, isAllowedNavigation, parseXUrl, type NewWindow } from "./urls";

const c = (pane: ChildPane, url: string, sized: boolean): NewWindow => classifyNewWindow(pane, url, sized, "https://builderwars.ai");

describe("classifyNewWindow (port of panes.rs tests)", () => {
  it("keeps auth popups in the app", () => {
    expect(c("xpane", "https://accounts.google.com/gsi/select?client_id=x", false)).toBe("popup");
    expect(c("xpane", "https://appleid.apple.com/auth/authorize?x=1", false)).toBe("popup");
    expect(c("game", "https://api.x.com/oauth/authorize", false)).toBe("popup");
    expect(c("xpane", "about:blank", false)).toBe("popup");
  });

  it("navigates the X pane for x.com links unless the request has popup features", () => {
    expect(c("xpane", "https://x.com/someone/status/1", false)).toBe("navigate-x");
    expect(c("game", "https://x.com/someone/status/1", false)).toBe("navigate-x");
    expect(c("xpane", "https://x.com/i/flow/login", true)).toBe("popup");
  });

  it("routes everything else", () => {
    expect(c("game", "https://builderwars.ai/portfolio/x", false)).toBe("navigate-self");
    expect(c("xpane", "https://builderwars.ai/portfolio/x", false)).toBe("external");
    expect(c("xpane", "https://example.com/", false)).toBe("external");
    expect(c("xpane", "https://google.com.evil.example/", false)).toBe("external");
    expect(c("xpane", "file:///etc/passwd", false)).toBe("deny");
    expect(c("xpane", "http://accounts.google.com/", false)).toBe("external");
    expect(c("game", "not a url", false)).toBe("deny");
  });
});

describe("url helpers", () => {
  it("detects popup features in window.open feature strings", () => {
    expect(hasPopupFeatures("width=500,height=600")).toBe(true);
    expect(hasPopupFeatures("left=10, top=10")).toBe(true);
    expect(hasPopupFeatures("")).toBe(false);
    expect(hasPopupFeatures("noopener,noreferrer")).toBe(false);
  });

  it("logs only scheme and host", () => {
    expect(hostForLog("https://builderwars.ai/auth/callback?code=SECRET&state=x")).toBe("https://builderwars.ai");
    expect(hostForLog(new URL("https://x.com/i/oauth2/authorize?code_challenge=y"))).toBe("https://x.com");
    expect(hostForLog("")).toBe("<invalid url>");
  });

  it("only accepts https x.com / twitter.com for the X pane", () => {
    expect(parseXUrl("https://x.com/i/grok").href).toBe("https://x.com/i/grok");
    expect(parseXUrl("https://mobile.twitter.com/a").hostname).toBe("mobile.twitter.com");
    expect(() => parseXUrl("http://x.com/")).toThrow("only https://x.com URLs");
    expect(() => parseXUrl("https://x.com.evil.example/")).toThrow();
    expect(() => parseXUrl("nope")).toThrow("invalid URL");
  });

  it("filters same-window navigation schemes", () => {
    expect(isAllowedNavigation("https://x.com/")).toBe(true);
    expect(isAllowedNavigation("about:blank")).toBe(true);
    expect(isAllowedNavigation("file:///etc/passwd")).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)")).toBe(false);
  });
});
