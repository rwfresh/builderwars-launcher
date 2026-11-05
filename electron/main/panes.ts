// The two web panes laid over placeholders in the shell UI: the game pane (our site) and the X
// pane (x.com), both WebContentsViews in the main window (port of panes.rs).
//
// Hard rule for the X pane (product constraint): no preload, no script of ours, no DOM/console/
// cookie access, no automation. We only create it, set its bounds, loadURL/goBack/reload it on an
// explicit user action, listen to its lifecycle events and route its window.open requests.

import { app, BrowserWindow, session, shell, WebContentsView, type Session, type WebContents } from "electron";
import {
  GAME_BRIDGE_ARG,
  SHELL_EVENTS,
  type ChildPane,
  type GameBridgeConfig,
  type PaneRect,
  type ShellEventName,
  type ShellEventPayloads,
} from "../shared/contract";
import { chromeUserAgent } from "./useragent";
import { classifyNewWindow, hasPopupFeatures, hostForLog, isAllowedNavigation, isExternalOpenable } from "./urls";

/** Shared, persistent "web profile" for the game and X panes (and their sign-in popups). */
export const WEB_PARTITION = "persist:web";

/** Sensitive capabilities a page would normally have to prompt for in Chrome; never granted silently. */
const DENIED_PERMISSIONS = new Set([
  "media",
  "geolocation",
  "notifications",
  "midi",
  "midiSysex",
  "hid",
  "serial",
  "usb",
  "display-capture",
  "idle-detection",
  "openExternal",
]);

/** Chromium's transient user activation lasts 5 s; popups without a recent gesture are blocked like Chrome does. */
export const USER_ACTIVATION_MS = 5000;
const ACTIVATING_INPUT = new Set(["mouseDown", "mouseUp", "keyDown", "rawKeyDown", "char", "gestureTap", "touchStart", "touchEnd", "pointerDown", "pointerUp"]);

export function webSession(): Session {
  const ses = session.fromPartition(WEB_PARTITION);
  ses.setUserAgent(chromeUserAgent(ses.getUserAgent(), app.getName(), app.getVersion()));
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(!DENIED_PERMISSIONS.has(permission)));
  return ses;
}

export interface PanesDeps {
  win: BrowserWindow;
  siteOrigin: string;
  gameStartUrl: string;
  gamePreload: string;
  bridgeConfig: GameBridgeConfig;
  /** Shown before a page has painted (the shell theme's background). */
  background: string;
  send<E extends ShellEventName>(event: E, payload: ShellEventPayloads[E]): void;
  /** F6 pressed in a pane: the shell cycles focus. */
  onF6(wc: WebContents): void;
}

const SECURE_PREFS = { contextIsolation: true, sandbox: true, nodeIntegration: false } as const;

export class Panes {
  readonly game: WebContentsView;
  readonly xpane: WebContentsView;
  /** Last user input (click/key/tap) per pane, for the popup blocker. */
  private activation: Record<ChildPane, number> = { game: 0, xpane: 0 };
  /** Last URL handed to loadURL per pane (getURL() is empty until the first commit). */
  private requested: Record<ChildPane, string> = { game: "", xpane: "" };

  constructor(private readonly d: PanesDeps) {
    const ses = webSession();
    this.game = new WebContentsView({
      webPreferences: {
        ...SECURE_PREFS,
        session: ses,
        preload: d.gamePreload,
        additionalArguments: [GAME_BRIDGE_ARG + JSON.stringify(d.bridgeConfig)],
      },
    });
    // No preload, nothing injected: see the hard rule above.
    this.xpane = new WebContentsView({ webPreferences: { ...SECURE_PREFS, session: ses } });
    for (const [pane, view] of [
      ["game", this.game],
      ["xpane", this.xpane],
    ] as const) {
      view.setBackgroundColor(d.background);
      view.setVisible(false);
      d.win.contentView.addChildView(view);
      this.wire(pane, view.webContents);
    }
  }

  view(pane: ChildPane): WebContentsView {
    return pane === "game" ? this.game : this.xpane;
  }

  /** Theme changed: the color shown behind a page that has not painted yet. Pages themselves are untouched. */
  setBackground(color: string): void {
    this.game.setBackgroundColor(color);
    this.xpane.setBackgroundColor(color);
  }

  start(): void {
    this.load("game", this.d.gameStartUrl);
    this.load("xpane", "https://x.com/home");
  }

  load(pane: ChildPane, url: string): void {
    this.requested[pane] = url;
    this.view(pane)
      .webContents.loadURL(url)
      .catch((e: unknown) => {
        // ERR_ABORTED (-3) is normal when a redirect or a newer navigation replaces this one.
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("ERR_ABORTED")) console.error(`[${pane}] load ${hostForLog(url)} failed: ${msg.replace(/\(.*$/, "").trim()}`);
      });
  }

  /** CSS px of the shell viewport = DIPs of the window content area, so no scaling is needed. */
  setBounds(pane: ChildPane, r: PaneRect, visible: boolean): void {
    const view = this.view(pane);
    if (process.env.BW_DEBUG_BOUNDS) console.log(`[pane_bounds] ${pane} ${r.x},${r.y} ${r.width}x${r.height} visible=${visible}`);
    if (!visible || r.width < 2 || r.height < 2) {
      view.setVisible(false);
      return;
    }
    view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
    view.setVisible(true);
  }

  goBack(pane: ChildPane): void {
    const h = this.view(pane).webContents.navigationHistory;
    if (h.canGoBack()) h.goBack();
  }

  reload(pane: ChildPane): void {
    this.view(pane).webContents.reload();
  }

  focus(pane: ChildPane): void {
    this.view(pane).webContents.focus();
  }

  /** Test hook (BW_AUTOTEST_POPUP): treat the pane as if the user had just clicked in it. */
  noteUserActivation(pane: ChildPane): void {
    this.activation[pane] = Date.now();
  }

  private emitLoad(pane: ChildPane, url: string, phase: "started" | "finished", log = true): void {
    // Host only: full URLs can carry OAuth codes and tokens.
    if (log) console.log(`[${pane}] page-load ${phase} ${hostForLog(url)}`);
    this.d.send(SHELL_EVENTS.paneLoad, { pane, url, phase });
  }

  private wire(pane: ChildPane, wc: WebContents): void {
    const url = () => wc.getURL() || this.requested[pane];
    // did-start-loading / did-stop-loading bracket the whole load (the tab spinner, subframes included).
    wc.on("did-start-loading", () => this.emitLoad(pane, url(), "started"));
    wc.on("did-stop-loading", () => this.emitLoad(pane, url(), "finished"));
    // Window-level input routing only (like the F6 hook): nothing is read from the page.
    wc.on("input-event", (_e, input) => {
      if (ACTIVATING_INPUT.has(input.type)) this.activation[pane] = Date.now();
    });
    wc.on("did-navigate", (_e, url) => this.emitLoad(pane, url, "finished", false));
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (isMainFrame) this.emitLoad(pane, url, "finished", false);
    });
    wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      console.error(`[${pane}] page-load failed ${hostForLog(url)} ${code} ${desc}`);
      this.emitLoad(pane, url, "finished", false);
    });
    wc.on("page-title-updated", (_e, title) => {
      console.log(`[${pane}] title ${JSON.stringify(title)}`);
      this.d.send(SHELL_EVENTS.paneTitle, { pane, title });
    });
    // Same-window navigations (the site's "Sign in with X" redirect to x.com and back) stay in the
    // pane; only odd schemes are refused. New windows are routed below.
    wc.on("will-navigate", (e) => {
      if (!isAllowedNavigation(e.url)) e.preventDefault();
    });
    wc.on("before-input-event", (e, input) => {
      if (input.type === "keyDown" && input.key === "F6") {
        e.preventDefault();
        this.d.onF6(wc);
      }
    });
    wc.setWindowOpenHandler(({ url, features }) => {
      const gesture = Date.now() - this.activation[pane] < USER_ACTIVATION_MS;
      // Chromium's content layer has no popup blocker (Chrome's lives above it): without a recent
      // user gesture, deny like Chrome would (and like WebKitGTK did in the Tauri launcher).
      const decision = gesture ? classifyNewWindow(pane, url, hasPopupFeatures(features), this.d.siteOrigin) : "deny";
      console.log(`[${pane}] new-window ${hostForLog(url)} -> ${decision}${gesture ? "" : " (no user gesture)"}`);
      switch (decision) {
        case "popup":
          // Electron child windows share the opener's session (same cookies) and keep
          // `window.opener`, so Google/Apple/X sign-in hands back to the opener as in Chrome.
          // Popups from the game view inherit its preload, which is safe: the preload defines the
          // bridge only on the site origin (top frame), and main only answers the game view itself.
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              title: "Sign in",
              width: 520,
              height: 720,
              parent: this.d.win,
              autoHideMenuBar: true,
              backgroundColor: "#ffffff",
              webPreferences: { ...SECURE_PREFS },
            },
          };
        case "navigate-x":
          this.load("xpane", url);
          this.d.send(SHELL_EVENTS.paneReveal, "xpane");
          return { action: "deny" };
        case "navigate-self":
          this.load(pane, url);
          return { action: "deny" };
        case "external":
          void shell.openExternal(url).catch((e: unknown) => console.error(`[panes] could not open ${hostForLog(url)}: ${String(e)}`));
          return { action: "deny" };
        case "deny":
          return { action: "deny" };
      }
    });
    wc.on("did-create-window", (popup) => {
      console.log(`[${pane}] popup window created`);
      popup.removeMenu();
      const pwc = popup.webContents;
      pwc.on("did-finish-load", () => console.log(`[signin] page-load finished ${hostForLog(pwc.getURL())}`));
      pwc.on("will-navigate", (e) => {
        if (!isAllowedNavigation(e.url)) e.preventDefault();
      });
      pwc.setWindowOpenHandler(({ url }) => {
        console.log(`[signin] new-window ${hostForLog(url)} -> external`);
        if (isExternalOpenable(url)) void shell.openExternal(url).catch(() => {});
        return { action: "deny" };
      });
    });
  }
}
