import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_BACKGROUNDS } from "../electron/shared/contract";
import { contrastRatio } from "./contrast";
import { THEME_IDS, TERMINAL_MIN_CONTRAST, TERMINAL_THEMES, isThemeId, type ThemeId } from "./themes";

/** The custom properties declared in each `:root[data-theme="..."]` block of styles.css. */
function cssTokens(): Record<string, Record<string, string>> {
  const css = fs.readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const themes: Record<string, Record<string, string>> = {};
  for (const block of css.matchAll(/:root\[data-theme="([a-z-]+)"\]\s*\{([^}]*)\}/g)) {
    const tokens: Record<string, string> = {};
    for (const decl of block[2]!.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) tokens[decl[1]!] = decl[2]!.trim().toLowerCase();
    themes[block[1]!] = tokens;
  }
  return themes;
}

const CSS = cssTokens();
const token = (theme: ThemeId, name: string): string => {
  const v = CSS[theme]?.[name];
  if (v == null) throw new Error(`styles.css: ${theme} has no ${name}`);
  return v;
};

describe("isThemeId", () => {
  it("accepts the theme ids and nothing else", () => {
    for (const id of THEME_IDS) expect(isThemeId(id)).toBe(true);
    for (const v of ["", "Dim", "neon", "lights out", null, undefined, 1, {}]) expect(isThemeId(v)).toBe(false);
  });
});

describe("theme backgrounds", () => {
  it("has a CSS block for every theme and none for unknown ones", () => {
    expect(Object.keys(CSS).sort()).toEqual([...THEME_IDS].sort());
  });

  it.each(THEME_IDS)("%s: terminal, window and CSS --bg agree", (id) => {
    expect(TERMINAL_THEMES[id].background).toBe(THEME_BACKGROUNDS[id]);
    expect(token(id, "--bg")).toBe(THEME_BACKGROUNDS[id]);
    expect(TERMINAL_THEMES[id].cursorAccent).toBe(THEME_BACKGROUNDS[id]);
  });
});

describe("contrast (WCAG AA, 4.5:1 for text)", () => {
  // The Settings and Run prompt? panels sit on --bg; --surface is the next step up.
  it.each(THEME_IDS)("%s: shell text tokens on the panel background", (id) => {
    const bg = token(id, "--bg");
    for (const name of ["--text", "--muted", "--placeholder", "--link", "--danger", "--warn"]) {
      expect(contrastRatio(token(id, name), bg), `${id} ${name} on --bg`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(token(id, "--muted"), token(id, "--surface"))).toBeGreaterThanOrEqual(4.5);
    // The prompt box placeholder sits on --raised.
    expect(contrastRatio(token(id, "--placeholder"), token(id, "--raised"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(THEME_IDS)("%s: the warning color is distinct from the accent and the text", (id) => {
    const warn = token(id, "--warn");
    expect(warn).not.toBe(token(id, "--accent"));
    expect(warn).not.toBe(token(id, "--text"));
    expect(warn).not.toBe(token(id, "--danger"));
  });

  it.each(THEME_IDS)("%s: terminal text colors on the terminal background", (id) => {
    const t = TERMINAL_THEMES[id];
    const dark = id !== "light";
    // black is a background color on dark terminals; white and brightWhite are on light ones (see TERMINAL_MIN_CONTRAST).
    const text = {
      foreground: t.foreground,
      ...(dark ? { white: t.white, brightWhite: t.brightWhite } : { black: t.black }),
      red: t.red,
      green: t.green,
      yellow: t.yellow,
      blue: t.blue,
      magenta: t.magenta,
      cyan: t.cyan,
      brightBlack: t.brightBlack,
      brightRed: t.brightRed,
      brightGreen: t.brightGreen,
      brightYellow: t.brightYellow,
      brightBlue: t.brightBlue,
      brightMagenta: t.brightMagenta,
      brightCyan: t.brightCyan,
    };
    for (const [name, color] of Object.entries(text)) {
      expect(color, `${id}.${name}`).toBeDefined();
      expect(contrastRatio(color!, t.background!), `${id}.${name} on the background`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("makes xterm enforce 4.5:1 on Dim and Light", () => {
    expect(TERMINAL_MIN_CONTRAST.light).toBeGreaterThanOrEqual(4.5);
    expect(TERMINAL_MIN_CONTRAST.dim).toBeGreaterThanOrEqual(4.5);
  });
});
