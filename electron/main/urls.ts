// URL rules shared by the panes, the bridge and the settings (port of panes.rs). Pure, no Electron.

import type { ChildPane } from "../shared/contract";

function tryUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** https and x.com / twitter.com (or a subdomain). Same rule as `isXUrl` in src/bridge.ts. */
export function isXHost(url: URL): boolean {
  const h = url.hostname;
  return url.protocol === "https:" && (h === "x.com" || h.endsWith(".x.com") || h === "twitter.com" || h.endsWith(".twitter.com"));
}

export function parseXUrl(raw: string): URL {
  const url = tryUrl(raw);
  if (!url) throw new Error("invalid URL");
  if (!isXHost(url)) throw new Error("only https://x.com URLs can be opened in the X pane");
  return url;
}

/**
 * Identity providers used by X's login (Sign in with Google / Apple) and X's own OAuth hosts:
 * their popups must stay in the app, because a popup opened in the system browser cannot talk
 * back to its opener (`window.opener.postMessage`) and the login gets stuck.
 */
export function isAuthHost(url: URL): boolean {
  const h = url.hostname;
  if (url.protocol !== "https:" || !h) return false;
  return (
    h === "google.com" ||
    h.endsWith(".google.com") ||
    h === "apple.com" ||
    h.endsWith(".apple.com") ||
    h === "api.x.com" ||
    h === "api.twitter.com"
  );
}

/** What to do with a `window.open` / `target=_blank` request from a pane. */
export type NewWindow =
  /** In-app "Sign in" popup window related to the opener (keeps `window.opener`, shares cookies). */
  | "popup"
  /** Load it in the X pane (tweet links etc.). */
  | "navigate-x"
  /** Load it in the requesting pane itself (the site's own pages in the game pane). */
  | "navigate-self"
  /** Hand it to the system browser. */
  | "external"
  | "deny";

/** True when `window.open` asked for a size or position (a real popup, not a link). */
export function hasPopupFeatures(features: string): boolean {
  return /(^|,)\s*(width|height|innerwidth|innerheight|left|top|screenx|screeny)\s*=/i.test(features);
}

/** `hasPopupFeatures`: the request carried a size/position (window.open with width/height). */
export function classifyNewWindow(pane: ChildPane, raw: string, popupFeatures: boolean, siteOrigin: string): NewWindow {
  const url = tryUrl(raw);
  if (!url) return "deny";
  if (url.protocol === "about:") {
    // window.open('') / about:blank, then scripted navigation: typical for auth popups.
    return "popup";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "deny";
  if (isAuthHost(url)) return "popup";
  if (isXHost(url)) return popupFeatures ? "popup" : "navigate-x";
  if (pane === "game" && url.origin === siteOrigin) return "navigate-self";
  return "external";
}

/** Scheme + host only: full URLs can carry OAuth codes and tokens, never log them. */
export function hostForLog(raw: string | URL): string {
  const url = typeof raw === "string" ? tryUrl(raw) : raw;
  if (!url) return "<invalid url>";
  return `${url.protocol}//${url.hostname}`;
}

/** Same-window navigations allowed in the panes and popups (port of the Rust on_navigation filter). */
export function isAllowedNavigation(raw: string): boolean {
  const url = tryUrl(raw);
  return url != null && ["http:", "https:", "about:", "blob:", "data:"].includes(url.protocol);
}

/** Open in the system browser: http(s) only. */
export function isExternalOpenable(raw: string): boolean {
  const url = tryUrl(raw);
  return url != null && (url.protocol === "https:" || url.protocol === "http:");
}
