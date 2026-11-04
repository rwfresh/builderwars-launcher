// PTY sessions over node-pty: spawn / write / resize / kill / is-idle (port of pty.rs).

import { execFile } from "node:child_process";
import fs from "node:fs";
import * as nodePty from "node-pty";
import { HERDR_SESSION, type PtyEvent, type PtyMode } from "../shared/contract";
import { childEnv } from "./childenv";
import { tpgidFromProcStat } from "./procstat";

interface Session {
  pty: nodePty.IPty;
  log: fs.WriteStream | null;
}

function command(mode: PtyMode): { file: string; args: string[] } {
  if (mode === "herdr") return { file: "herdr", args: ["--session", HERDR_SESSION] };
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"] };
  // $SHELL as a login shell.
  return { file: process.env.SHELL || "/bin/bash", args: ["-l"] };
}

function foregroundGroup(pid: number): Promise<number | null> {
  if (process.platform === "linux") {
    return fs.promises.readFile(`/proc/${pid}/stat`, "utf8").then(tpgidFromProcStat, () => null);
  }
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile("ps", ["-o", "tpgid=", "-p", String(pid)], { timeout: 1000 }, (err, stdout) => {
        const v = Number(String(stdout).trim());
        resolve(err || !Number.isInteger(v) ? null : v);
      });
    });
  }
  return Promise.resolve(null);
}

export class PtyManager {
  private sessions = new Map<number, Session>();
  private next = 0;

  constructor(private readonly emit: (id: number, event: PtyEvent) => void) {}

  spawn(mode: PtyMode, cols: number, rows: number, cwd: string): number {
    const { file, args } = command(mode);
    const pty = nodePty.spawn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor", BUILDERWARS_LAUNCHER: "1" }),
    });
    const id = ++this.next;
    const logPath = process.env.BW_PTY_LOG;
    const log = logPath ? fs.createWriteStream(logPath, { flags: "a" }) : null;
    log?.on("error", () => {});
    this.sessions.set(id, { pty, log });
    pty.onData((data) => {
      log?.write(data);
      this.emit(id, { kind: "data", data });
    });
    pty.onExit(({ exitCode }) => {
      const s = this.sessions.get(id);
      if (s?.pty === pty) this.sessions.delete(id);
      log?.end();
      this.emit(id, { kind: "exit", code: exitCode });
    });
    return id;
  }

  private get(id: number): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such pty");
    return s;
  }

  write(id: number, data: string): void {
    this.get(id).pty.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    this.get(id).pty.resize(cols, rows);
  }

  kill(id: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try {
      s.pty.kill();
    } catch {
      /* already gone */
    }
  }

  /** True when the shell itself is the foreground process (nothing else running in it). Unknown platforms report true. */
  async isIdle(id: number): Promise<boolean> {
    const s = this.get(id);
    if (process.platform === "win32") return true;
    const fg = await foregroundGroup(s.pty.pid);
    return fg == null ? true : fg === s.pty.pid;
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}
