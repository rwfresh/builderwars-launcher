import { afterEach, describe, expect, it } from "vitest";
import { childEnv } from "./childenv";
import { mergePath } from "./envinfo";
import { tpgidFromProcStat } from "./procstat";
import { chromeUserAgent } from "./useragent";

describe("small helpers", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("reads tpgid from /proc/<pid>/stat, even with spaces and parens in comm", () => {
    expect(tpgidFromProcStat("1234 (bash) S 1 1234 1234 34816 1234 4194560 100 0")).toBe(1234);
    expect(tpgidFromProcStat("1234 (my (odd) cmd) S 1 1234 1234 34816 5678 4194560")).toBe(5678);
    expect(tpgidFromProcStat("garbage")).toBeNull();
  });

  it("strips the herdr context from child environments", () => {
    process.env.HERDR_PANE_ID = "p1";
    process.env.HERDR_SOCKET_PATH = "/tmp/s";
    const env = childEnv({ TERM: "xterm-256color" });
    expect(env.HERDR_PANE_ID).toBeUndefined();
    expect(env.HERDR_SOCKET_PATH).toBeUndefined();
    expect(env.TERM).toBe("xterm-256color");
  });

  it("merges the login shell PATH first without duplicates", () => {
    expect(mergePath("/a:/b", "/b:/c:")).toBe("/a:/b:/c");
  });

  it("removes the app tokens from the user agent", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) BuilderWars/0.1.0 Chrome/156.0.8078.80 Electron/45.2.2 Safari/537.36";
    expect(chromeUserAgent(ua, "Builder Wars", "0.1.0")).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.80 Safari/537.36",
    );
    expect(chromeUserAgent(ua.replace("BuilderWars/0.1.0", "@builderwars/launcher/0.1.0"), "@builderwars/launcher", "0.1.0")).not.toMatch(
      /builderwars|Electron/i,
    );
  });
});
