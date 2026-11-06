// Launcher settings, persisted as JSON (port of settings.rs). No Electron imports: the caller
// passes the settings file path (userData/settings.json), so this module is unit-testable.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_SETTINGS, THEME_IDS, type Settings } from "../shared/contract";

export const DEFAULT_SITE_URL = DEFAULT_SETTINGS.siteUrl;
export const DEFAULT_WORK_DIR_NAME = "BuilderWars";

export const WORK_DIR_README = `# Builder Wars workspace

This folder was created by the Builder Wars launcher. Your AI agent (Claude Code, Codex, Gemini,
Grok, opencode) starts here when you press "Run in terminal" on builderwars.ai, so promo video
drafts, spec sheets and renders for your Builder Wars products live here.

Change it in the launcher toolbar (the folder under the terminal > Change). Deleting this folder is safe; the launcher
recreates it (empty) the next time it starts with the default setting.
`;

/**
 * Same shape as the Rust serde struct: camelCase, every field optional with a default. Strict: `settings:set` uses it,
 * so the shell can't save an unknown theme.
 */
export const settingsSchema = z.object({
  defaultAgent: z.string().nullable().default(DEFAULT_SETTINGS.defaultAgent),
  useHerdr: z.boolean().nullable().default(DEFAULT_SETTINGS.useHerdr),
  grokUrl: z.string().default(DEFAULT_SETTINGS.grokUrl),
  siteUrl: z.string().default(DEFAULT_SETTINGS.siteUrl),
  workDir: z.string().nullable().default(DEFAULT_SETTINGS.workDir),
  theme: z.enum(THEME_IDS).default(DEFAULT_SETTINGS.theme),
});

/**
 * settings.json as read from disk. A theme this version doesn't know (written by a newer launcher, or edited by hand)
 * falls back to the default on its own instead of failing the parse and resetting every other setting.
 */
const storedSettingsSchema = settingsSchema.extend({
  theme: z.enum(THEME_IDS).catch(DEFAULT_SETTINGS.theme),
});

/** Missing file, bad JSON or wrong types: defaults (like serde's `unwrap_or_default`). An unknown theme: default theme. */
export function loadSettings(file: string): Settings {
  try {
    const r = storedSettingsSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return r.success ? r.data : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(file: string, s: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

/** Configured work dir, or ~/BuilderWars. `~/` prefixes are expanded. */
export function resolveWorkDir(s: Pick<Settings, "workDir">, home: string): string {
  const d = s.workDir?.trim() ?? "";
  if (d === "") return path.join(home, DEFAULT_WORK_DIR_NAME);
  if (d === "~") return home;
  if (d.startsWith("~/") || d.startsWith("~\\")) return path.join(home, d.slice(2));
  return d;
}

/** Create the work dir if missing (with a README explaining it). Returns the directory. */
export function ensureWorkDir(dir: string): string {
  try {
    if (fs.statSync(dir).isDirectory()) return dir;
  } catch {
    /* missing */
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`cannot create ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const readme = path.join(dir, "README.md");
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, WORK_DIR_README);
  return dir;
}

/** Parse and normalise a site URL: http(s) only, returns base URL without trailing slash + origin. */
export function parseSiteUrl(raw: string): { base: string; origin: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch (e) {
    throw new Error(`invalid site URL: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("site URL must be http(s)");
  return { base: url.href.replace(/\/+$/, ""), origin: url.origin };
}

/** Site URL precedence: `--url <u>` / `--url=<u>` arg > BW_SITE_URL env > settings > default. Invalid candidates are skipped. */
export function resolveSiteUrl(s: Pick<Settings, "siteUrl">, argv: readonly string[], envSiteUrl: string | undefined): { base: string; origin: string } {
  let fromArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--url") fromArg = argv[++i];
    else if (a.startsWith("--url=")) fromArg = a.slice("--url=".length);
  }
  for (const c of [fromArg, envSiteUrl, s.siteUrl]) {
    if (c == null) continue;
    try {
      return parseSiteUrl(c);
    } catch {
      /* next */
    }
  }
  return parseSiteUrl(DEFAULT_SITE_URL);
}
