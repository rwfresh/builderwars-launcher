// Prompt dispatch through herdr's CLI wrappers over its socket API (port of herdr.rs).
//
// We target the launcher's own named session (`herdr --session builderwars`, started in the PTY),
// never the user's default session. Flow: find the focused pane; if its shell is idle at the prompt
// run the agent command there, otherwise split a new pane to the right and run it there.
// `pane run` sends text + Enter atomically. We deliberately use `pane run "<agent> '<prompt>'"`
// instead of `agent start` + `agent prompt`: `agent start` reports `agent_not_ready` when the CLI
// opens a first-run/trust dialog and the prompt would be lost, while passing the prompt as the CLI's
// initial-prompt argument survives such dialogs. herdr still detects and tracks the agent in the pane.

import { execFile, execFileSync } from "node:child_process";
import { HERDR_SESSION, type HerdrDispatch } from "../shared/contract";
import { childEnv } from "./childenv";

type Json = unknown;

function pointer(v: Json, path: string[]): Json {
  let cur = v;
  for (const k of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export type HerdrRunner = (args: string[]) => Promise<Json>;

export const runHerdr: HerdrRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "herdr",
      ["--session", HERDR_SESSION, ...args],
      { env: childEnv(), maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code !== "number") {
          reject(new Error(`herdr not runnable: ${err.message}`));
          return;
        }
        if (err) {
          let msg = stderr.trim();
          try {
            const m = pointer(JSON.parse(stderr), ["error", "message"]);
            if (typeof m === "string") msg = m;
          } catch {
            /* plain text */
          }
          reject(new Error(`herdr ${args[0] ?? ""}: ${msg}`));
          return;
        }
        // Some commands (e.g. `pane run`) print nothing on success.
        if (stdout.trim() === "") {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`herdr returned non-JSON: ${e instanceof Error ? e.message : String(e)}`));
        }
      },
    );
  });

/** `command` already starts with a `cd <work dir> &&` prefix (built by the shell UI); `cwd` is used for new splits. */
export async function dispatch(command: string, cwd: string, herdr: HerdrRunner = runHerdr): Promise<HerdrDispatch> {
  const list = await herdr(["pane", "list"]);
  const panes = pointer(list, ["result", "panes"]);
  if (!Array.isArray(panes)) throw new Error("herdr pane list: unexpected shape");
  const pane = panes.find((p) => pointer(p, ["focused"]) === true) ?? panes[0];
  if (pane == null) throw new Error("herdr has no panes");
  const paneId = pointer(pane, ["pane_id"]);
  if (typeof paneId !== "string") throw new Error("pane without id");

  const info = await herdr(["pane", "process-info", "--pane", paneId]);
  const fg = pointer(info, ["result", "process_info", "foreground_process_group_id"]);
  const shell = pointer(info, ["result", "process_info", "shell_pid"]);
  const idle = Number.isInteger(fg) && Number.isInteger(shell) && fg === shell;

  let target = paneId;
  let split = false;
  if (!idle) {
    const res = await herdr(["pane", "split", "--pane", paneId, "--direction", "right", "--cwd", cwd]);
    const id = pointer(res, ["result", "pane", "pane_id"]);
    if (typeof id !== "string") throw new Error("herdr pane split: no pane id");
    target = id;
    split = true;
  }
  await herdr(["pane", "run", target, command]);
  return { paneId: target, split };
}

/** Runs `herdr session <verb> builderwars` (no --session prefix: these address the server, not a pane). */
export type SessionCmdRunner = (verb: "stop" | "delete") => Promise<void>;

export const runSessionCmd: SessionCmdRunner = (verb) =>
  new Promise((resolve, reject) => {
    execFile("herdr", ["session", verb, HERDR_SESSION], { env: childEnv(), timeout: 5000, encoding: "utf8" }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`herdr session ${verb}: ${String(stderr).trim() || err.message}`));
      else resolve();
    });
  });

/**
 * A launch starts from a clean terminal: stop the launcher's herdr session if a previous run (or a
 * crash) left it running in herdr's background server, and delete its saved layout, so
 * `herdr --session builderwars` opens one pane instead of restoring every split ever made.
 * Both steps are best effort: "no such session" is the normal case.
 */
export async function resetSession(run: SessionCmdRunner = runSessionCmd): Promise<{ stopped: boolean; deleted: boolean }> {
  const stopped = await run("stop").then(() => true, () => false);
  const deleted = await run("delete").then(() => true, () => false);
  return { stopped, deleted };
}

/** On quit: end the session so nothing keeps running in herdr's server after the launcher closes. Synchronous, bounded. */
export function stopSessionSync(): void {
  try {
    execFileSync("herdr", ["session", "stop", HERDR_SESSION], { env: childEnv(), timeout: 3000, stdio: "ignore" });
  } catch {
    /* not running, or herdr missing */
  }
}
