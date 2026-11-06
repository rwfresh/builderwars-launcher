import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/contract";
import { ensureWorkDir, loadSettings, parseSiteUrl, resolveSiteUrl, resolveWorkDir, saveSettings, settingsSchema } from "./settings";

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bw-settings-test-"));
  tmp.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("work dir (port of settings.rs tests)", () => {
  it("defaults and expands tilde", () => {
    // Expected paths use the platform separator: resolveWorkDir joins with node:path ("\\" on Windows).
    const home = path.join(path.sep, "home", "u");
    expect(resolveWorkDir({ workDir: null }, home)).toBe(path.join(home, "BuilderWars"));
    expect(resolveWorkDir({ workDir: "~/code/bw" }, home)).toBe(path.join(home, "code", "bw"));
    expect(resolveWorkDir({ workDir: "~\\code\\bw" }, home)).toBe(path.join(home, "code\\bw"));
    expect(resolveWorkDir({ workDir: "~" }, home)).toBe(home);
    expect(resolveWorkDir({ workDir: "/srv/bw" }, home)).toBe("/srv/bw");
    expect(resolveWorkDir({ workDir: "  " }, home)).toBe(path.join(home, "BuilderWars"));
  });

  it("creates the README once and keeps the user's copy", () => {
    const dir = path.join(tmpDir(), "work");
    ensureWorkDir(dir);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toContain("Builder Wars");
    fs.writeFileSync(path.join(dir, "README.md"), "mine");
    ensureWorkDir(dir);
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("mine");
  });

  it("does not add a README to an existing directory", () => {
    const dir = tmpDir();
    ensureWorkDir(dir);
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(false);
  });
});

describe("settings file", () => {
  it("round-trips camelCase JSON and falls back to defaults", () => {
    const file = path.join(tmpDir(), "nested", "settings.json");
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
    const s = { ...DEFAULT_SETTINGS, defaultAgent: "codex", useHerdr: false, workDir: "~/bw" };
    saveSettings(file, s);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(s);
    expect(loadSettings(file)).toEqual(s);
    fs.writeFileSync(file, JSON.stringify({ defaultAgent: "gemini" }));
    expect(loadSettings(file)).toEqual({ ...DEFAULT_SETTINGS, defaultAgent: "gemini" });
    fs.writeFileSync(file, "{not json");
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
    fs.writeFileSync(file, JSON.stringify({ useHerdr: "yes" }));
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  it("defaults the theme to Lights out and keeps a saved one", () => {
    const file = path.join(tmpDir(), "settings.json");
    // A settings.json written before themes existed has no theme field.
    fs.writeFileSync(file, JSON.stringify({ defaultAgent: "claude", workDir: null }));
    expect(loadSettings(file).theme).toBe("lights-out");
    saveSettings(file, { ...DEFAULT_SETTINGS, theme: "dim" });
    expect(loadSettings(file).theme).toBe("dim");
    fs.writeFileSync(file, JSON.stringify({ theme: "neon" }));
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  it("drops only an unknown or invalid stored theme and keeps the other settings", () => {
    const file = path.join(tmpDir(), "settings.json");
    const saved = { defaultAgent: "codex", useHerdr: false, grokUrl: "https://x.com/i/grok", siteUrl: "http://localhost:3000", workDir: "~/bw" };
    for (const theme of ["neon", 42, null]) {
      fs.writeFileSync(file, JSON.stringify({ ...saved, theme }));
      expect(loadSettings(file)).toEqual({ ...saved, theme: "lights-out" });
    }
  });

  it("still rejects an unknown theme over IPC (settings:set validates with settingsSchema)", () => {
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, theme: "neon" }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, theme: "dim" }).success).toBe(true);
  });
});

describe("site URL", () => {
  it("normalises", () => {
    expect(parseSiteUrl("https://builderwars.ai/")).toEqual({ base: "https://builderwars.ai", origin: "https://builderwars.ai" });
    expect(parseSiteUrl(" http://localhost:3000 ")).toEqual({ base: "http://localhost:3000", origin: "http://localhost:3000" });
    expect(() => parseSiteUrl("file:///etc/passwd")).toThrow("site URL must be http(s)");
    expect(() => parseSiteUrl("nope")).toThrow("invalid site URL");
  });

  it("resolves --url > BW_SITE_URL > settings > default, skipping invalid candidates", () => {
    const s = { siteUrl: "https://settings.example" };
    expect(resolveSiteUrl(s, ["electron", ".", "--url", "http://localhost:3000"], "https://env.example").origin).toBe("http://localhost:3000");
    expect(resolveSiteUrl(s, ["--url=https://arg.example/"], undefined).base).toBe("https://arg.example");
    expect(resolveSiteUrl(s, [], "https://env.example").origin).toBe("https://env.example");
    expect(resolveSiteUrl(s, ["--url", "ftp://bad"], undefined).origin).toBe("https://settings.example");
    expect(resolveSiteUrl({ siteUrl: "bad" }, [], "also bad").origin).toBe("https://builderwars.ai");
  });
});
