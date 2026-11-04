// Builder Wars launcher, Electron main process (ported from the Tauri launcher, src-tauri/src/lib.rs).
// One window: the shell renderer (our UI: terminal, toolbars, dividers) with two WebContentsViews
// on top (game = our site, xpane = x.com). Contract: electron/shared/contract.ts.

import { app, BrowserWindow, dialog, Menu, session, type WebContents } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  BRIDGE_CHANNELS,
  DEEP_LINK_SCHEME,
  SHELL_CHANNELS,
  SHELL_EVENTS,
  type ChildPane,
  type GameBridgeConfig,
  type LauncherInfo,
  type Settings,
  type ShellEventName,
  type ShellEventPayloads,
} from "../shared/contract";
import { autotestBridge, autotestPopup } from "./autotest";
import { PromptBridge } from "./bridge";
import { DeepLinkQueue, deepLinksInArgv } from "./deeplink";
import { adoptLoginShellPath, detect } from "./envinfo";
import { dispatch as herdrDispatch } from "./herdr";
import { dimArg, handleBridge, handleShell, idArg, paneArg, rectArg } from "./ipc";
import { Panes } from "./panes";
import { PtyManager } from "./pty";
import { ensureWorkDir, loadSettings, parseSiteUrl, resolveSiteUrl, resolveWorkDir, saveSettings, settingsSchema } from "./settings";
import { hostForLog, parseXUrl } from "./urls";
import { validateAgent } from "./validate";

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTOTEST = process.env.BW_AUTOTEST === "1";

// Must run before anything reads PATH (agent detection, PTY, herdr).
adoptLoginShellPath();

// BW_DATA_ROOT=<dir> relocates settings and the persist:web profile (tests, side-by-side
// instances). Before whenReady and before the single-instance lock (which lives in userData).
const dataRoot = process.env.BW_DATA_ROOT;
if (dataRoot) app.setPath("userData", path.resolve(dataRoot));

function main(): void {
  if (!app.requestSingleInstanceLock()) {
    // Another launcher owns this profile; it receives our argv (deep link) via second-instance.
    app.quit();
    return;
  }

  const env = detect();
  const home = os.homedir();
  const settingsFile = path.join(app.getPath("userData"), "settings.json");
  let settings: Settings = loadSettings(settingsFile);
  // Test/dev override, not persisted: BW_USE_HERDR=0|1.
  if (process.env.BW_USE_HERDR != null) settings.useHerdr = process.env.BW_USE_HERDR === "1";
  const site = resolveSiteUrl(settings, process.argv, process.env.BW_SITE_URL);
  const useHerdr = (settings.useHerdr ?? env.herdr) && env.herdr;
  const defaultAgent = settings.defaultAgent != null && env.agents.includes(settings.defaultAgent) ? settings.defaultAgent : (env.agents[0] ?? null);
  console.log(
    `[launcher] site=${site.base} agents=[${env.agents.map((a) => JSON.stringify(a)).join(", ")}] herdr=${env.herdr} (use=${useHerdr}) shell=${env.shell}`,
  );

  /** The agents' work directory, created on demand; falls back to home if it cannot be created. */
  const workDir = (): string => {
    try {
      return ensureWorkDir(resolveWorkDir(settings, home));
    } catch (e) {
      console.error(`[launcher] work dir: ${e instanceof Error ? e.message : String(e)}; using home`);
      return home;
    }
  };
  console.log(`[launcher] work dir ${workDir()}`);

  let win: BrowserWindow | null = null;
  let panes: Panes | null = null;
  const shellWc = (): WebContents | null => (win && !win.isDestroyed() ? win.webContents : null);
  const gameWc = (): WebContents | null => (panes && !panes.game.webContents.isDestroyed() ? panes.game.webContents : null);
  const send = <E extends ShellEventName>(event: E, payload: ShellEventPayloads[E]): void => {
    const wc = shellWc();
    if (wc && !wc.isDestroyed()) wc.send(event, payload);
  };
  const focusWindow = () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  // Deep links: queued, confirmed in the shell, never run by themselves.
  const links = new DeepLinkQueue();
  const handleUrls = (urls: string[]) => {
    if (urls.length === 0) return;
    const { queued, errors } = links.add(urls);
    for (const req of queued) {
      console.log(`[deeplink] queued run request (${[...req.prompt].length} chars, agent=${req.agent == null ? "None" : JSON.stringify(req.agent)})`);
    }
    for (const e of errors) {
      console.error(`[deeplink] ignored ${DEEP_LINK_SCHEME}: ${e}`);
      send(SHELL_EVENTS.notice, `ignored deep link: ${e}`);
    }
    if (queued.length > 0) {
      send(SHELL_EVENTS.deeplinkPending, undefined);
      focusWindow();
    }
  };
  app.on("second-instance", (_e, argv) => {
    focusWindow();
    handleUrls(deepLinksInArgv(argv));
  });
  // macOS delivers links as Apple events (also on cold start, before ready).
  app.on("open-url", (e, url) => {
    e.preventDefault();
    handleUrls([url]);
  });
  // Installers register the scheme (deb/rpm .desktop MimeType, NSIS registry, macOS Info.plist);
  // runtime registration for packaged builds, opt-in for dev because it points the OS at the dev binary.
  if (app.isPackaged || process.env.BW_REGISTER_DEEPLINK === "1") {
    const ok = process.defaultApp
      ? app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1] ?? ".")])
      : app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    if (!ok) console.error("[deeplink] register failed");
  }

  const pty = new PtyManager((id, event) => send(SHELL_EVENTS.ptyEvent, { id, event }));
  const bridge = new PromptBridge({
    request: (ev) => send(SHELL_EVENTS.bridgeRunPrompt, ev),
    expired: (id) => send(SHELL_EVENTS.bridgeExpired, id),
    log: (line) => console.log(line),
  });

  // ---- shell-only IPC ----
  handleShell(SHELL_CHANNELS.launcherInfo, z.tuple([]), shellWc, (): LauncherInfo => ({
    env,
    settings: { ...settings },
    siteUrl: site.base,
    siteOrigin: site.origin,
    workDir: workDir(),
    home,
    autotest: AUTOTEST,
  }));
  // Print a line to the launcher's stdout (diagnostics).
  handleShell(SHELL_CHANNELS.debugLog, z.tuple([z.string()]), shellWc, (msg) => {
    console.log(`[shell] ${[...msg].slice(0, 500).join("")}`);
  });
  handleShell(SHELL_CHANNELS.settingsSet, z.tuple([settingsSchema]), shellWc, (next) => {
    parseSiteUrl(next.siteUrl);
    parseXUrl(next.grokUrl);
    if (next.defaultAgent != null) validateAgent(next.defaultAgent);
    if (next.workDir != null && next.workDir.trim() !== "") {
      const dir = resolveWorkDir(next, home);
      if (!path.isAbsolute(dir)) throw new Error("work directory must be an absolute path (or start with ~/)");
      ensureWorkDir(dir);
    }
    saveSettings(settingsFile, next);
    settings = next;
  });
  handleShell(SHELL_CHANNELS.pickWorkDir, z.tuple([]), shellWc, async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: "Builder Wars work directory",
      defaultPath: workDir(),
      properties: ["openDirectory", "createDirectory"],
    });
    const picked = r.canceled ? undefined : r.filePaths[0];
    if (!picked) return null;
    const dir = ensureWorkDir(picked);
    const s = { ...settings, workDir: dir };
    saveSettings(settingsFile, s);
    settings = s;
    return dir;
  });
  handleShell(SHELL_CHANNELS.ptySpawn, z.tuple([z.enum(["shell", "herdr"]), dimArg, dimArg]), shellWc, (mode, cols, rows) => {
    try {
      const id = pty.spawn(mode, cols, rows, workDir());
      console.log(`[pty] spawn mode=${mode} ${cols}x${rows} -> Ok(${id})`);
      return id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[pty] spawn mode=${mode} ${cols}x${rows} -> Err(${JSON.stringify(msg)})`);
      throw new Error(msg);
    }
  });
  handleShell(SHELL_CHANNELS.ptyWrite, z.tuple([idArg, z.string()]), shellWc, (id, data) => pty.write(id, data));
  handleShell(SHELL_CHANNELS.ptyResize, z.tuple([idArg, dimArg, dimArg]), shellWc, (id, cols, rows) => pty.resize(id, cols, rows));
  handleShell(SHELL_CHANNELS.ptyKill, z.tuple([idArg]), shellWc, (id) => {
    console.log(`[pty] kill ${id}`);
    pty.kill(id);
  });
  handleShell(SHELL_CHANNELS.ptyIsIdle, z.tuple([idArg]), shellWc, (id) => pty.isIdle(id));
  handleShell(SHELL_CHANNELS.herdrDispatch, z.tuple([z.string().min(1)]), shellWc, (command) => herdrDispatch(command, workDir()));
  handleShell(SHELL_CHANNELS.paneBounds, z.tuple([paneArg, rectArg, z.boolean()]), shellWc, (pane, rect, visible) => {
    if (!panes) throw new Error("pane missing");
    panes.setBounds(pane, rect, visible);
  });
  handleShell(
    SHELL_CHANNELS.paneNav,
    z.tuple([paneArg, z.enum(["back", "reload", "go"]), z.string().nullable().optional()]),
    shellWc,
    (pane, action, url) => {
      if (!panes) throw new Error("pane missing");
      if (action === "back") return panes.goBack(pane);
      if (action === "reload") return panes.reload(pane);
      if (url == null) throw new Error("missing url");
      let target: string;
      if (pane === "xpane") {
        target = parseXUrl(url).href;
      } else {
        let u: URL;
        try {
          u = new URL(url);
        } catch {
          throw new Error("invalid URL");
        }
        if (u.origin !== site.origin) throw new Error("game pane only navigates within the site");
        target = u.href;
      }
      panes.load(pane, target);
    },
  );
  handleShell(SHELL_CHANNELS.paneFocus, z.tuple([z.enum(["terminal", "game", "xpane", "x"])]), shellWc, (pane) => {
    if (pane === "terminal") shellWc()?.focus();
    else panes?.focus(pane === "x" ? "xpane" : pane);
  });
  handleShell(SHELL_CHANNELS.deeplinkTake, z.tuple([]), shellWc, () => links.take());
  handleShell(SHELL_CHANNELS.bridgeResolve, z.tuple([idArg, z.boolean(), z.string().max(10_000)]), shellWc, (id, ok, value) =>
    bridge.resolve(id, ok, value),
  );

  // ---- game-view bridge IPC (site origin only) ----
  handleBridge(BRIDGE_CHANNELS.runPrompt, z.tuple([z.string(), z.string().nullable()]), gameWc, site.origin, (prompt, agent) =>
    bridge.runPrompt(prompt, agent),
  );
  handleBridge(BRIDGE_CHANNELS.openX, z.tuple([z.string().nullable()]), gameWc, site.origin, (url) => {
    const target = url == null || url === "" ? null : parseXUrl(url);
    console.log(`[bridge] open_x ${target ? hostForLog(target) : "None"}`);
    if (target) {
      if (!panes) throw new Error("X pane missing");
      panes.load("xpane", target.href);
    }
    send(SHELL_EVENTS.paneReveal, "xpane" satisfies ChildPane);
  });

  // Cold start: the link that launched us (argv on Linux/Windows; macOS uses open-url).
  const coldLinks = deepLinksInArgv(process.argv.slice(1));

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => pty.killAll());

  void app.whenReady().then(() => {
    // Our own UI (default session) never needs a permission prompt beyond clipboard writes.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "clipboard-sanitized-write"));
    if (process.platform === "darwin") {
      // macOS needs an application menu for the standard edit shortcuts (copy/paste) to work.
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]),
      );
    } else {
      Menu.setApplicationMenu(null);
    }

    const icon = path.join(app.getAppPath(), "build", "icon.png");
    win = new BrowserWindow({
      title: "Builder Wars",
      width: 1600,
      height: 1000,
      minWidth: 960,
      minHeight: 600,
      backgroundColor: "#05080a",
      ...(process.platform === "linux" && fs.existsSync(icon) ? { icon } : {}),
      webPreferences: {
        preload: path.join(here, "../preload/shell.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const shell = win.webContents;
    // The shell never navigates away or opens windows.
    shell.on("will-navigate", (e) => e.preventDefault());
    shell.setWindowOpenHandler(() => ({ action: "deny" }));
    shell.on("render-process-gone", (_e, d) => {
      console.error(`[launcher] shell renderer gone: ${d.reason}`);
      bridge.dropAll();
    });
    shell.on("console-message", (e) => {
      if (e.level === "error" || e.level === "warning") console.log(`[shell:console] ${e.level} ${JSON.stringify(e.message.slice(0, 500))} (${e.sourceId}:${e.lineNumber})`);
    });
    const f6 = (wc: WebContents) =>
      wc.on("before-input-event", (e, input) => {
        if (input.type === "keyDown" && input.key === "F6") {
          e.preventDefault();
          send(SHELL_EVENTS.focusCycle, undefined);
        }
      });
    f6(shell);

    const bridgeConfig: GameBridgeConfig = { origin: site.origin, platform: env.platform, agents: env.agents, defaultAgent, herdr: useHerdr };
    panes = new Panes({
      win,
      siteOrigin: site.origin,
      gameStartUrl: `${site.base}/dashboard`,
      gamePreload: path.join(here, "../preload/game.js"),
      bridgeConfig,
      send,
      onF6: () => send(SHELL_EVENTS.focusCycle, undefined),
    });
    console.log(`[launcher] web user agent ${panes.game.webContents.session.getUserAgent()}`);

    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
    const loaded = devUrl ? shell.loadURL(devUrl) : shell.loadFile(path.join(here, "../renderer/index.html"));
    loaded.catch((e: unknown) => console.error(`[launcher] shell failed to load: ${String(e)}`));
    panes.start();
    if (process.env.BW_DEVTOOLS === "1") shell.openDevTools({ mode: "detach" });

    win.on("closed", () => {
      win = null;
      panes = null;
    });

    handleUrls(coldLinks);
    if (AUTOTEST) autotestBridge(panes.game.webContents, shell);
    if (process.env.BW_AUTOTEST_POPUP === "1") {
      autotestPopup(panes.game.webContents, () => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
    }
  });
}

main();
