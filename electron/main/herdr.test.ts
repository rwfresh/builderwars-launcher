import { describe, expect, it } from "vitest";
import { dispatch, resetSession, type HerdrRunner, type SessionCmdRunner } from "./herdr";

function fake(responses: Record<string, unknown>): { run: HerdrRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: HerdrRunner = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    if (!(key in responses)) throw new Error(`unexpected ${key}`);
    return responses[key];
  };
  return { run, calls };
}

const list = { result: { panes: [{ pane_id: "p1" }, { pane_id: "p2", focused: true }] } };

describe("herdr dispatch (port of herdr.rs)", () => {
  it("runs in the focused pane when its shell is idle", async () => {
    const { run, calls } = fake({
      "pane list": list,
      "pane process-info": { result: { process_info: { foreground_process_group_id: 42, shell_pid: 42 } } },
      "pane run": null,
    });
    await expect(dispatch("cd ~/BuilderWars && claude 'hi'", "/home/u/BuilderWars", run)).resolves.toEqual({ paneId: "p2", split: false });
    expect(calls.at(-1)).toEqual(["pane", "run", "p2", "cd ~/BuilderWars && claude 'hi'"]);
  });

  it("splits right when the pane is busy", async () => {
    const { run, calls } = fake({
      "pane list": list,
      "pane process-info": { result: { process_info: { foreground_process_group_id: 7, shell_pid: 42 } } },
      "pane split": { result: { pane: { pane_id: "p3" } } },
      "pane run": null,
    });
    await expect(dispatch("x", "/w", run)).resolves.toEqual({ paneId: "p3", split: true });
    expect(calls[2]).toEqual(["pane", "split", "--pane", "p2", "--direction", "right", "--cwd", "/w"]);
  });

  it("reports unexpected shapes", async () => {
    await expect(dispatch("x", "/w", fake({ "pane list": { result: {} } }).run)).rejects.toThrow("herdr pane list: unexpected shape");
    await expect(dispatch("x", "/w", fake({ "pane list": { result: { panes: [] } } }).run)).rejects.toThrow("herdr has no panes");
  });
});

describe("herdr session reset (one pane per launch)", () => {
  it("stops, then deletes, the launcher session", async () => {
    const calls: string[] = [];
    const run: SessionCmdRunner = async (verb) => {
      calls.push(verb);
    };
    expect(await resetSession(run)).toEqual({ stopped: true, deleted: true });
    expect(calls).toEqual(["stop", "delete"]);
  });

  it("treats a missing session as the normal case", async () => {
    const run: SessionCmdRunner = async (verb) => {
      throw new Error(`herdr session ${verb}: no such session`);
    };
    expect(await resetSession(run)).toEqual({ stopped: false, deleted: false });
  });
});
