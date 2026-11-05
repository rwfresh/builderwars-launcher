import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { DOWNLOAD_PAGE_URL, type UpdateState } from "../shared/contract";
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  UP_TO_DATE_VISIBLE_MS,
  UpdateController,
  noUpdateArgs,
  parseFeedOverride,
  redactUrls,
  selectUpdateMode,
  type Timers,
  type UpdaterLike,
  type UpdaterLogger,
  type UpdaterTrace,
} from "./updater";

/** Stand-in for electron-updater's AppUpdater: checkForUpdates() returns a promise the test settles. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  logger: UpdaterLogger | null = null;
  feed: unknown = null;
  checks = 0;
  installs = 0;
  pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null;
  setFeedURL(options: { provider: "generic"; url: string }): void {
    this.feed = options;
  }
  checkForUpdates(): Promise<unknown> {
    this.checks++;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
  quitAndInstall(): void {
    this.installs++;
  }
  /** Settle the running check. */
  finish(result: unknown = { isUpdateAvailable: false }): void {
    const p = this.pending;
    this.pending = null;
    p?.resolve(result);
  }
  fail(e: Error): void {
    const p = this.pending;
    this.pending = null;
    this.emit("error", e); // electron-updater emits, then rejects
    p?.reject(e);
  }
}

/** Manual clock for setTimeout / setInterval. */
class FakeTimers implements Timers {
  now = 0;
  private seq = 0;
  private items = new Map<number, { at: number; fn: () => void; every: number | null }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.items.set(id, { at: this.now + ms, fn, every: null });
    return id;
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.items.set(id, { at: this.now + ms, fn, every: ms });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.items.delete(h as number);
  }
  clearInterval(h: unknown): void {
    this.items.delete(h as number);
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.items.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      this.now = t.at;
      if (t.every != null) t.at += t.every;
      else this.items.delete(id);
      t.fn();
    }
    this.now = end;
  }
  get pending(): number {
    return this.items.size;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(mode: "auto" | "notify" = "auto", feedUrl: string | null = null) {
  const updater = new FakeUpdater();
  const timers = new FakeTimers();
  const states: UpdateState[] = [];
  const traces: UpdaterTrace[] = [];
  const opened: string[] = [];
  const lines: string[] = [];
  const c = new UpdateController({
    updater,
    mode,
    currentVersion: "0.2.0",
    feedUrl,
    timers,
    notify: (s) => states.push(s),
    openExternal: (url) => {
      opened.push(url);
    },
    log: { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) },
  });
  c.subscribe((t) => traces.push(t));
  c.start();
  return { c, updater, timers, states, traces, opened, lines };
}

describe("selectUpdateMode", () => {
  it("is off for unpackaged builds on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(selectUpdateMode({ isPackaged: false, platform, appImage: "/x/a.AppImage" })).toBe("off");
    }
  });
  it("auto-updates macOS, Windows and AppImage; notifies other Linux packaging", () => {
    expect(selectUpdateMode({ isPackaged: true, platform: "darwin", appImage: undefined })).toBe("auto");
    expect(selectUpdateMode({ isPackaged: true, platform: "win32", appImage: undefined })).toBe("auto");
    expect(selectUpdateMode({ isPackaged: true, platform: "linux", appImage: "/home/u/Apps/bw.AppImage" })).toBe("auto");
    expect(selectUpdateMode({ isPackaged: true, platform: "linux", appImage: undefined })).toBe("notify"); // deb, rpm
    expect(selectUpdateMode({ isPackaged: true, platform: "linux", appImage: "" })).toBe("notify");
    expect(selectUpdateMode({ isPackaged: true, platform: "freebsd", appImage: undefined })).toBe("off");
  });
});

describe("parseFeedOverride", () => {
  it("is none when unset", () => {
    expect(parseFeedOverride(undefined)).toEqual({ kind: "none" });
    expect(parseFeedOverride("  ")).toEqual({ kind: "none" });
  });
  it("accepts http(s) on loopback names only", () => {
    expect(parseFeedOverride("http://127.0.0.1:8123/")).toEqual({ kind: "ok", url: "http://127.0.0.1:8123/" });
    expect(parseFeedOverride("https://localhost/feed")).toEqual({ kind: "ok", url: "https://localhost/feed" });
    expect(parseFeedOverride("http://[::1]:9000")).toEqual({ kind: "ok", url: "http://[::1]:9000/" });
  });
  it("ignores everything else", () => {
    for (const raw of [
      "http://example.com/",
      "https://127.0.0.1.evil.com/",
      "http://localhost.evil.com/",
      "http://127.0.0.2/",
      "http://0.0.0.0/",
      "file:///tmp/feed",
      "ftp://127.0.0.1/",
      "http://user:pw@127.0.0.1/",
      "127.0.0.1:8000",
      "not a url",
    ]) {
      expect(parseFeedOverride(raw).kind, raw).toBe("ignored");
    }
  });
});

describe("redactUrls", () => {
  it("drops query strings and fragments", () => {
    expect(redactUrls("GET https://objects.example.com/a/b.zip?X-Amz-Signature=abc&t=1 failed")).toBe("GET https://objects.example.com/a/b.zip failed");
    expect(redactUrls("see http://127.0.0.1:8000/x#frag")).toBe("see http://127.0.0.1:8000/x");
    expect(redactUrls("no url here?q")).toBe("no url here?q");
  });
});

describe("noUpdateArgs (IPC payload)", () => {
  it("accepts no arguments only", () => {
    expect(noUpdateArgs.safeParse([]).success).toBe(true);
    expect(noUpdateArgs.safeParse(["https://evil.example/"]).success).toBe(false);
    expect(noUpdateArgs.safeParse([{ url: "x" }]).success).toBe(false);
  });
});

describe("UpdateController setup", () => {
  it("configures the updater for auto mode", () => {
    const { updater } = setup("auto");
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.feed).toBeNull();
  });
  it("never downloads in notify mode", () => {
    const { updater } = setup("notify");
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
  });
  it("uses a generic provider for the feed override", () => {
    const { updater } = setup("auto", "http://127.0.0.1:8123/");
    expect(updater.feed).toEqual({ provider: "generic", url: "http://127.0.0.1:8123/" });
  });
  it("prefixes the updater's own log lines and strips query strings", () => {
    const { updater, lines } = setup();
    updater.logger?.info("Downloading update from https://cdn.example/x.AppImage?token=secret");
    expect(lines.at(-1)).toBe("[updater] Downloading update from https://cdn.example/x.AppImage");
  });
});

describe("UpdateController schedule", () => {
  it("checks once after the startup delay, then every 4 hours", () => {
    const { updater, timers } = setup();
    timers.advance(FIRST_CHECK_DELAY_MS - 1);
    expect(updater.checks).toBe(0);
    timers.advance(1);
    expect(updater.checks).toBe(1);
    updater.finish();
    return flush().then(() => {
      timers.advance(CHECK_INTERVAL_MS - 1);
      expect(updater.checks).toBe(1);
      timers.advance(1);
      expect(updater.checks).toBe(2);
    });
  });

  it("never runs two checks at once; a manual click joins the running check", async () => {
    const { c, updater, timers, states } = setup();
    timers.advance(FIRST_CHECK_DELAY_MS);
    expect(updater.checks).toBe(1);
    const manual = c.checkNow();
    expect(updater.checks).toBe(1);
    expect(states.at(-1)).toEqual({ kind: "checking" });
    timers.advance(CHECK_INTERVAL_MS); // the interval fires while the check still runs
    expect(updater.checks).toBe(1);
    updater.emit("update-not-available", { version: "0.2.0" });
    updater.finish();
    await manual;
    expect(states.at(-1)).toEqual({ kind: "up-to-date", version: "0.2.0" });
    void c.checkNow();
    expect(updater.checks).toBe(2);
  });

  it("stop() clears the timers", () => {
    const { c, timers } = setup();
    c.stop();
    expect(timers.pending).toBe(0);
  });
});

describe("UpdateController states", () => {
  it("background check in auto mode: downloading with percent, then ready", async () => {
    const { updater, timers, states, traces } = setup("auto");
    timers.advance(FIRST_CHECK_DELAY_MS);
    updater.emit("checking-for-update");
    expect(states).toEqual([]); // background checks are quiet
    updater.emit("update-available", { version: "0.2.1" });
    updater.finish({ isUpdateAvailable: true, downloadPromise: Promise.reject(new Error("handled elsewhere")) });
    await flush();
    updater.emit("download-progress", { percent: 12.7 });
    updater.emit("download-progress", { percent: 12.9 }); // same integer: no new state
    updater.emit("download-progress", { percent: 100 });
    updater.emit("update-downloaded", { version: "0.2.1" });
    expect(states).toEqual([
      { kind: "downloading", version: "0.2.1", percent: 0 },
      { kind: "downloading", version: "0.2.1", percent: 12 },
      { kind: "downloading", version: "0.2.1", percent: 100 },
      { kind: "ready", version: "0.2.1" },
    ]);
    expect(traces.map((t) => t.event)).toEqual(["checking", "available", "progress", "progress", "downloaded"]);
  });

  it("background check that finds nothing or fails changes nothing and only logs", async () => {
    const { updater, timers, states, lines } = setup("auto");
    timers.advance(FIRST_CHECK_DELAY_MS);
    updater.emit("update-not-available", { version: "0.2.0" });
    updater.finish();
    await flush();
    timers.advance(CHECK_INTERVAL_MS);
    updater.fail(new Error("net::ERR_INTERNET_DISCONNECTED"));
    await flush();
    expect(states).toEqual([]);
    expect(lines.some((l) => l.startsWith("[updater]") && l.includes("ERR_INTERNET_DISCONNECTED"))).toBe(true);
  });

  it("background download failure goes back to idle", async () => {
    const { updater, timers, states } = setup("auto");
    timers.advance(FIRST_CHECK_DELAY_MS);
    updater.emit("update-available", { version: "0.2.1" });
    updater.finish({ isUpdateAvailable: true });
    await flush();
    updater.emit("error", new Error("sha512 checksum mismatch"));
    expect(states.at(-1)).toEqual({ kind: "idle" });
  });

  it("manual check: checking, then up-to-date that clears itself", async () => {
    const { c, updater, timers, states } = setup("auto");
    const p = c.checkNow();
    updater.emit("checking-for-update");
    updater.emit("update-not-available", { version: "0.2.0" });
    updater.finish();
    await p;
    expect(states).toEqual([{ kind: "checking" }, { kind: "up-to-date", version: "0.2.0" }]);
    timers.advance(UP_TO_DATE_VISIBLE_MS);
    expect(states.at(-1)).toEqual({ kind: "idle" });
  });

  it("manual check: errors are shown, without query strings", async () => {
    const { c, updater, states } = setup("auto");
    const p = c.checkNow();
    updater.fail(new Error("HttpError: 404 https://example.com/latest.yml?token=abc\n  at stack"));
    await p;
    expect(states).toEqual([{ kind: "checking" }, { kind: "error", message: "HttpError: 404 https://example.com/latest.yml" }]);
  });

  it("manual check on a build whose updater is inactive reports an error", async () => {
    const { c, updater, states } = setup("notify");
    const p = c.checkNow();
    updater.finish(null);
    await p;
    expect(states.at(-1)).toEqual({ kind: "error", message: "updates are not available for this build" });
  });

  it("download failure after a manual check is shown", async () => {
    const { c, updater, states } = setup("auto");
    const p = c.checkNow();
    updater.emit("update-available", { version: "0.2.1" });
    updater.finish({ isUpdateAvailable: true });
    await p;
    updater.emit("error", new Error("download failed"));
    expect(states.at(-1)).toEqual({ kind: "error", message: "download failed" });
  });

  it("notify mode: available, and idle again when the release is pulled", async () => {
    const { updater, timers, states } = setup("notify");
    timers.advance(FIRST_CHECK_DELAY_MS);
    updater.emit("update-available", { version: "0.2.1" });
    updater.finish({ isUpdateAvailable: true, downloadPromise: null });
    await flush();
    expect(states).toEqual([{ kind: "available", version: "0.2.1" }]);
    timers.advance(CHECK_INTERVAL_MS);
    updater.emit("update-not-available", { version: "0.2.0" });
    updater.finish();
    await flush();
    expect(states.at(-1)).toEqual({ kind: "idle" });
  });

  it("ignores events with a malformed version", () => {
    const { updater, states } = setup("auto");
    updater.emit("update-available", { version: 3 });
    updater.emit("update-downloaded", {});
    expect(states).toEqual([]);
  });

  it("a manual check while ready shows ready again without a network call", async () => {
    const { c, updater, states } = setup("auto");
    updater.emit("update-available", { version: "0.2.1" });
    updater.emit("update-downloaded", { version: "0.2.1" });
    await c.checkNow();
    expect(updater.checks).toBe(0);
    expect(states.at(-1)).toEqual({ kind: "ready", version: "0.2.1" });
  });

  it("skips background checks once an update is ready", async () => {
    const { updater, timers } = setup("auto");
    updater.emit("update-available", { version: "0.2.1" });
    updater.emit("update-downloaded", { version: "0.2.1" });
    timers.advance(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(0);
  });
});

describe("UpdateController actions", () => {
  it("restart runs quitAndInstall only when an update is ready", () => {
    const { c, updater, traces } = setup("auto");
    expect(() => c.restart()).toThrow(/no update is ready/);
    updater.emit("update-available", { version: "0.2.1" });
    expect(() => c.restart()).toThrow(/no update is ready/); // still downloading
    expect(updater.installs).toBe(0);
    updater.emit("update-downloaded", { version: "0.2.1" });
    c.restart();
    expect(updater.installs).toBe(1);
    expect(traces.at(-1)?.event).toBe("install");
  });

  it("notify mode opens the fixed download page", async () => {
    const { c, opened } = setup("notify");
    await c.openDownload();
    expect(opened).toEqual([DOWNLOAD_PAGE_URL]);
    expect(DOWNLOAD_PAGE_URL).toBe("https://builderwars.ai/download");
  });

  it("auto mode refuses the download action", async () => {
    const { c, opened } = setup("auto");
    await expect(c.openDownload()).rejects.toThrow();
    expect(opened).toEqual([]);
  });
});
