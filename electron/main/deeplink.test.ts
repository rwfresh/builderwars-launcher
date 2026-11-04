import { describe, expect, it } from "vitest";
import { DeepLinkQueue, deepLinksInArgv, parseDeepLink } from "./deeplink";

describe("deep links (port of deeplink.rs tests)", () => {
  it("parses run links", () => {
    expect(parseDeepLink("builderwars://run?prompt=make%20a%20promo%20%22now%22&agent=codex")).toEqual({
      prompt: 'make a promo "now"',
      agent: "codex",
    });
    expect(parseDeepLink("builderwars:run?prompt=hi").agent).toBeNull();
    expect(parseDeepLink("builderwars:///run?prompt=hi&agent=").agent).toBeNull();
    expect(parseDeepLink("builderwars://run?prompt=a+b").prompt).toBe("a b");
  });

  it("rejects bad links", () => {
    expect(() => parseDeepLink("builderwars://run")).toThrow("deep link without prompt");
    expect(() => parseDeepLink("builderwars://run?prompt=%20")).toThrow("empty prompt");
    expect(() => parseDeepLink("builderwars://delete?prompt=x")).toThrow('unknown deep link action "delete"');
    expect(() => parseDeepLink("builderwars://run?prompt=x&agent=rm%20-rf")).toThrow("invalid agent id");
    expect(() => parseDeepLink("https://run?prompt=x")).toThrow("not a builderwars:// link");
  });

  it("finds links in argv and queues valid ones", () => {
    expect(deepLinksInArgv(["/usr/bin/bw", "--flag", "builderwars://run?prompt=hi", "BuilderWars:run?prompt=x"])).toEqual([
      "builderwars://run?prompt=hi",
      "BuilderWars:run?prompt=x",
    ]);
    const q = new DeepLinkQueue();
    const r = q.add(["builderwars://run?prompt=hi", "builderwars://nope"]);
    expect(r.queued).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(q.take()).toEqual([{ prompt: "hi", agent: null }]);
    expect(q.take()).toEqual([]);
  });
});
