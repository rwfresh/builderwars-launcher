// Shell color themes. The CSS tokens live in styles.css under :root[data-theme=...]; this file holds what CSS
// can't reach: the xterm.js palette and the labels for the settings picker. The themes style our own UI only.
// The game pane and x.com keep their own look (x.com follows the player's X display setting).
import type { ITheme } from "@xterm/xterm";
import { THEME_IDS, type ThemeId } from "../electron/shared/contract";

export { THEME_IDS, type ThemeId };

export const THEME_LABELS: Record<ThemeId, string> = {
  "lights-out": "Lights out",
  dim: "Dim",
  light: "Light",
};

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);
}

/**
 * Terminal palettes. Agents mostly paint their own truecolor UI; these cover the shell prompt and plain ANSI
 * output. brightBlack is the "dim" text many CLIs use, so it stays readable (4.5:1) on each background.
 */
export const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
  "lights-out": {
    background: "#000000",
    foreground: "#e7e9ea",
    cursor: "#1d9bf0",
    cursorAccent: "#000000",
    selectionBackground: "#1d9bf059",
    black: "#2f3336",
    red: "#f4212e",
    green: "#00ba7c",
    yellow: "#ffd400",
    blue: "#1d9bf0",
    magenta: "#f91880",
    cyan: "#38bdf8",
    white: "#e7e9ea",
    brightBlack: "#8b9095",
    brightRed: "#ff5c68",
    brightGreen: "#3ddc97",
    brightYellow: "#ffe45c",
    brightBlue: "#5ab8f5",
    brightMagenta: "#ff5ca8",
    brightCyan: "#7dd3fc",
    brightWhite: "#ffffff",
  },
  dim: {
    background: "#15202b",
    foreground: "#f7f9f9",
    cursor: "#1d9bf0",
    cursorAccent: "#15202b",
    selectionBackground: "#1d9bf059",
    black: "#38444d",
    red: "#f4212e",
    green: "#00ba7c",
    yellow: "#ffd400",
    blue: "#1d9bf0",
    magenta: "#f91880",
    cyan: "#38bdf8",
    white: "#f7f9f9",
    brightBlack: "#8b98a5",
    brightRed: "#ff5c68",
    brightGreen: "#3ddc97",
    brightYellow: "#ffe45c",
    brightBlue: "#5ab8f5",
    brightMagenta: "#ff5ca8",
    brightCyan: "#7dd3fc",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff",
    foreground: "#0f1419",
    cursor: "#1270b8",
    cursorAccent: "#ffffff",
    selectionBackground: "#1d9bf040",
    black: "#0f1419",
    red: "#d0141f",
    green: "#00805a",
    yellow: "#8a6a00",
    blue: "#1270b8",
    magenta: "#c4126a",
    cyan: "#0e7490",
    // "white" text is common in CLI output; on a white background it has to be a readable grey.
    white: "#536471",
    brightBlack: "#536471",
    brightRed: "#a3101a",
    brightGreen: "#006647",
    brightYellow: "#6b5200",
    brightBlue: "#0b5a96",
    brightMagenta: "#9c0e54",
    brightCyan: "#155e75",
    brightWhite: "#0f1419",
  },
};
