// Environment discovery: the user's login-shell PATH, installed agent CLIs, herdr (port of envinfo.rs).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EnvInfo, LauncherPlatform } from "../shared/contract";

/** Agent CLIs we know how to start with an initial prompt (mapping lives in src/agents.ts). */
export const AGENTS = ["claude", "codex", "gemini", "grok", "opencode"] as const;

export function platform(): LauncherPlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

export function userShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  const s = process.env.SHELL;
  return s && s !== "" ? s : "/bin/bash";
}

/** Merge a login-shell PATH in front of the current one, dropping empties and duplicates. */
export function mergePath(loginPath: string, current: string, sep = ":"): string {
  const parts: string[] = [];
  for (const p of [...loginPath.split(sep), ...current.split(sep)]) {
    if (p !== "" && !parts.includes(p)) parts.push(p);
  }
  return parts.join(sep);
}

/**
 * Apps started from a desktop launcher often get a minimal PATH (no mise/asdf/npm-global shims),
 * so agent CLIs would look "not installed". Ask the user's login+interactive shell for its PATH
 * and prepend it. Unix only; runs synchronously before anything else (4 s timeout).
 */
export function adoptLoginShellPath(): void {
  if (process.platform === "win32") return;
  const shell = userShell();
  const isFish = shell.endsWith("/fish") || shell === "fish";
  const script = isFish ? "printf '__BWPATH__%s__BWPATH__' (string join : $PATH)" : "printf '__BWPATH__%s__BWPATH__' \"$PATH\"";
  const r = spawnSync(shell, ["-l", "-i", "-c", script], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 4000,
    killSignal: "SIGKILL",
    encoding: "utf8",
  });
  if (r.error || typeof r.stdout !== "string") return;
  const loginPath = r.stdout.split("__BWPATH__")[1];
  if (loginPath == null) return;
  process.env.PATH = mergePath(loginPath, process.env.PATH ?? "");
}

function isExecutable(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First match of `name` on PATH (on Windows also name.exe / name.cmd), or null. */
export function which(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((d) => d !== "");
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const d of dirs) {
    for (const n of names) {
      const f = path.join(d, n);
      if (isExecutable(f)) return f;
    }
  }
  return null;
}

export function detect(): EnvInfo {
  return {
    platform: platform(),
    shell: userShell(),
    agents: AGENTS.filter((a) => which(a) != null),
    herdr: which("herdr") != null,
  };
}
