// Auto-updates from the public releases feed (electron-updater; README "Updates").
//
// - Packaged builds only. Unpackaged and dev builds never construct the updater, so they make no network calls.
// - Mode "auto" (macOS, Windows, Linux AppImage): download in the background, install on "Restart now" or on quit.
// - Mode "notify" (deb, rpm and any other Linux packaging): only say that a new version exists and link to the
//   download page. Installing a deb or rpm needs a privileged package-manager call (pkexec), which the app never runs.
// - The feed is the `publish` entry of electron-builder.yml, embedded in the app as app-update.yml. The only override
//   is BW_UPDATE_FEED_URL for local end-to-end tests, and only to a loopback address.
//
// Everything Electron-specific (the autoUpdater object, app info, timers, shell.openExternal, IPC) is injected, so the
// logic is unit-tested in updater.test.ts.

import { z } from "zod";
import { DOWNLOAD_PAGE_URL, type UpdateMode, type UpdateState } from "../shared/contract";

export const FIRST_CHECK_DELAY_MS = 10_000;
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** How long "You're on the latest version" stays up after a check the player asked for. */
export const UP_TO_DATE_VISIBLE_MS = 8_000;

/** All update IPC channels take no arguments; anything else is rejected. */
export const noUpdateArgs = z.tuple([]);

/**
 * How electron-updater started this process. Only the AppImage updater starts the new version itself, after moving it
 * over the old file:
 *   - "relaunch": "Restart now" (quitAndInstall) spawns it with APPIMAGE_SILENT_INSTALL=true to run as the new app,
 *     usually while the old instance is still quitting and holding the single-instance lock.
 *   - "exit-after-install": install on quit runs it synchronously with APPIMAGE_EXIT_AFTER_INSTALL=true as well, only
 *     to finish the install. The quitting old instance waits for it to exit, so it must exit at once.
 */
export function updateRelaunchKind(env: Record<string, string | undefined>): "none" | "relaunch" | "exit-after-install" {
  if (env.APPIMAGE_SILENT_INSTALL !== "true") return "none";
  return env.APPIMAGE_EXIT_AFTER_INSTALL === "true" ? "exit-after-install" : "relaunch";
}

/** Which kind of updating this build does. */
export function selectUpdateMode(p: { isPackaged: boolean; platform: NodeJS.Platform; appImage: string | undefined }): UpdateMode {
  if (!p.isPackaged) return "off";
  if (p.platform === "darwin" || p.platform === "win32") return "auto";
  if (p.platform === "linux") return p.appImage != null && p.appImage !== "" ? "auto" : "notify";
  return "off";
}

export type FeedOverride = { kind: "none" } | { kind: "ok"; url: string } | { kind: "ignored"; reason: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** BW_UPDATE_FEED_URL (test hook): accepted only as an http(s) URL on 127.0.0.1, localhost or [::1]. */
export function parseFeedOverride(raw: string | undefined): FeedOverride {
  if (raw == null || raw.trim() === "") return { kind: "none" };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { kind: "ignored", reason: "not a URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { kind: "ignored", reason: "only http and https are allowed" };
  if (!LOOPBACK_HOSTS.has(u.hostname)) return { kind: "ignored", reason: "the host must be 127.0.0.1, localhost or [::1]" };
  if (u.username !== "" || u.password !== "") return { kind: "ignored", reason: "credentials are not allowed" };
  return { kind: "ok", url: u.href };
}

/** Drops query strings and fragments from every URL in a log line (signed download URLs carry tokens). */
export function redactUrls(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, "$1");
}

export interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
}

/** The subset of electron-updater's AppUpdater used here. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  logger: UpdaterLogger | null;
  setFeedURL(options: { provider: "generic"; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  // any[]: matches EventEmitter.on, so electron-updater's AppUpdater fits without a cast.
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface UpdaterDeps {
  updater: UpdaterLike;
  mode: Exclude<UpdateMode, "off">;
  currentVersion: string;
  /** Validated BW_UPDATE_FEED_URL (see parseFeedOverride), or null for the built-in feed. */
  feedUrl: string | null;
  timers: Timers;
  /** Sends the state to the shell. */
  notify(state: UpdateState): void;
  openExternal(url: string): Promise<void> | void;
  /** Plain log sinks; the controller adds the `[updater]` prefix and strips query strings. */
  log: { info(line: string): void; warn(line: string): void; error(line: string): void };
}

export type UpdaterEventName = "checking" | "available" | "not-available" | "progress" | "downloaded" | "error" | "install";

/** What subscribers (the autotest) see: the updater event, the state after it, and whether a manual check caused it. */
export interface UpdaterTrace {
  event: UpdaterEventName;
  state: UpdateState;
  version: string | null;
  manual: boolean;
}

const updateInfoSchema = z.object({ version: z.string().min(1).max(64) });
const progressSchema = z.object({ percent: z.number().finite() });

function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const first = raw.split("\n")[0] ?? raw;
  return redactUrls(first).slice(0, 300);
}

export class UpdateController {
  private current: UpdateState = { kind: "idle" };
  private inFlight: Promise<void> | null = null;
  /** The running check was asked for by the player. */
  private manual = false;
  /** The update being downloaded was found by a manual check (so its errors are shown). */
  private foundByManual = false;
  private firstTimer: unknown = null;
  private interval: unknown = null;
  private upToDateTimer: unknown = null;
  private started = false;
  private readonly subscribers = new Set<(t: UpdaterTrace) => void>();

  constructor(private readonly deps: UpdaterDeps) {}

  get mode(): Exclude<UpdateMode, "off"> {
    return this.deps.mode;
  }

  get state(): UpdateState {
    return this.current;
  }

  /** Configures the updater and schedules the checks: the first after FIRST_CHECK_DELAY_MS, then every CHECK_INTERVAL_MS. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const { updater, mode, timers, feedUrl } = this.deps;
    updater.autoDownload = mode === "auto";
    updater.autoInstallOnAppQuit = mode === "auto";
    updater.allowPrerelease = false; // a bad release is pulled by marking it a prerelease
    updater.allowDowngrade = false;
    updater.logger = {
      info: (m) => this.info(String(m)),
      warn: (m) => this.warn(String(m)),
      error: (m) => this.error(String(m)),
    };
    if (feedUrl != null) {
      updater.setFeedURL({ provider: "generic", url: feedUrl });
      this.warn("using the test feed from BW_UPDATE_FEED_URL");
    }
    updater.on("checking-for-update", () => this.trace("checking", null));
    updater.on("update-available", (info: unknown) => this.onAvailable(info));
    updater.on("update-not-available", (info: unknown) => this.onNotAvailable(info));
    updater.on("download-progress", (p: unknown) => this.onProgress(p));
    updater.on("update-downloaded", (info: unknown) => this.onDownloaded(info));
    updater.on("error", (e: unknown) => this.onError(e));
    this.info(`mode=${mode} version=${this.deps.currentVersion}`);
    this.firstTimer = timers.setTimeout(() => {
      this.firstTimer = null;
      void this.check(false);
      this.interval = timers.setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
    }, FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    const t = this.deps.timers;
    if (this.firstTimer != null) t.clearTimeout(this.firstTimer);
    if (this.interval != null) t.clearInterval(this.interval);
    if (this.upToDateTimer != null) t.clearTimeout(this.upToDateTimer);
    this.firstTimer = this.interval = this.upToDateTimer = null;
  }

  /** A check the player asked for. Resolves when the check is done; the outcome arrives as states. */
  checkNow(): Promise<void> {
    return this.check(true);
  }

  /** Quit and install. Only while an update is ready. */
  restart(): void {
    if (this.current.kind !== "ready") throw new Error("no update is ready to install");
    this.info(`installing ${this.current.version} and restarting (quitAndInstall)`);
    this.trace("install", this.current.version);
    this.deps.updater.quitAndInstall();
  }

  /** Notify mode: open the fixed download page in the system browser. */
  async openDownload(): Promise<void> {
    if (this.deps.mode !== "notify") throw new Error("this build installs updates itself");
    this.info("opening the download page");
    await this.deps.openExternal(DOWNLOAD_PAGE_URL);
  }

  subscribe(fn: (t: UpdaterTrace) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private check(manual: boolean): Promise<void> {
    const s = this.current;
    // A downloaded or downloading update needs no new check; a manual check just shows where it stands.
    if (s.kind === "ready" || s.kind === "downloading") {
      if (manual) this.deps.notify(s);
      return Promise.resolve();
    }
    if (manual) {
      this.manual = true;
      this.setState({ kind: "checking" });
    }
    if (this.inFlight) return this.inFlight; // never two checks at once; a manual click joins the running one
    this.inFlight = (async () => {
      try {
        const r = (await this.deps.updater.checkForUpdates()) as { downloadPromise?: Promise<unknown> | null } | null | undefined;
        // Download failures arrive as "error" events; keep the promise from becoming an unhandled rejection.
        r?.downloadPromise?.catch(() => {});
        if (r == null) this.failCheck("updates are not available for this build");
      } catch (e) {
        this.failCheck(errorMessage(e));
      } finally {
        this.inFlight = null;
        this.manual = false;
        if (this.current.kind === "checking") this.setState({ kind: "idle" });
      }
    })();
    return this.inFlight;
  }

  /** A check failed (the "error" event usually reported it already). */
  private failCheck(message: string): void {
    if (this.manual) {
      if (this.current.kind !== "error") this.setState({ kind: "error", message });
    } else {
      this.warn(`background check failed: ${message}`);
    }
  }

  private onAvailable(raw: unknown): void {
    const version = this.version(raw);
    if (version == null) return;
    this.info(`update available: ${version} (current ${this.deps.currentVersion})`);
    this.foundByManual = this.manual;
    this.setState(this.deps.mode === "auto" ? { kind: "downloading", version, percent: 0 } : { kind: "available", version });
    this.trace("available", version);
  }

  private onNotAvailable(raw: unknown): void {
    const latest = this.version(raw);
    this.info(`up to date: ${this.deps.currentVersion} (feed has ${latest ?? "?"})`);
    if (this.manual) {
      this.setState({ kind: "up-to-date", version: this.deps.currentVersion });
      if (this.upToDateTimer != null) this.deps.timers.clearTimeout(this.upToDateTimer);
      this.upToDateTimer = this.deps.timers.setTimeout(() => {
        this.upToDateTimer = null;
        if (this.current.kind === "up-to-date") this.setState({ kind: "idle" });
      }, UP_TO_DATE_VISIBLE_MS);
    } else if (this.current.kind === "available") {
      // The release we announced was pulled.
      this.setState({ kind: "idle" });
    }
    this.trace("not-available", latest);
  }

  private onProgress(raw: unknown): void {
    const s = this.current;
    const p = progressSchema.safeParse(raw);
    if (s.kind !== "downloading" || !p.success) return;
    const percent = Math.max(0, Math.min(100, Math.floor(p.data.percent)));
    if (percent === s.percent) return;
    this.setState({ ...s, percent });
    this.trace("progress", s.version);
  }

  private onDownloaded(raw: unknown): void {
    const version = this.version(raw);
    if (version == null) return;
    this.info(`update downloaded: ${version}; installs on restart or quit`);
    this.setState({ kind: "ready", version });
    this.trace("downloaded", version);
  }

  private onError(e: unknown): void {
    const message = errorMessage(e);
    this.error(`error: ${message}`);
    if (this.manual || (this.current.kind === "downloading" && this.foundByManual)) {
      if (this.current.kind !== "error" || this.current.message !== message) this.setState({ kind: "error", message });
    } else if (this.current.kind === "downloading") {
      this.setState({ kind: "idle" }); // background download failed; the next check retries
    }
    this.trace("error", null);
  }

  private version(raw: unknown): string | null {
    const r = updateInfoSchema.safeParse(raw);
    if (!r.success) {
      this.warn("ignored an update event without a valid version");
      return null;
    }
    return r.data.version;
  }

  private setState(next: UpdateState): void {
    this.current = next;
    this.deps.notify(next);
  }

  private trace(event: UpdaterEventName, version: string | null): void {
    const t: UpdaterTrace = { event, state: this.current, version, manual: this.manual };
    for (const fn of this.subscribers) {
      try {
        fn(t);
      } catch (e) {
        this.error(`subscriber failed: ${errorMessage(e)}`);
      }
    }
  }

  private info(m: string): void {
    this.deps.log.info(`[updater] ${redactUrls(m)}`);
  }
  private warn(m: string): void {
    this.deps.log.warn(`[updater] ${redactUrls(m)}`);
  }
  private error(m: string): void {
    this.deps.log.error(`[updater] ${redactUrls(m)}`);
  }
}
