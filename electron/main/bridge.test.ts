import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunPromptEvent } from "../shared/contract";
import { PromptBridge } from "./bridge";

function setup(timeoutMs = 1000) {
  const requests: RunPromptEvent[] = [];
  const expired: number[] = [];
  const b = new PromptBridge({ request: (e) => requests.push(e), expired: (id) => expired.push(id), log: () => {} }, timeoutMs);
  return { b, requests, expired };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PromptBridge (port of bridge.rs run_prompt / bridge_resolve)", () => {
  it("forwards to the shell and resolves with the agent", async () => {
    const { b, requests } = setup();
    const p = b.runPrompt("hello", "claude");
    expect(requests).toEqual([{ id: 1, prompt: "hello", agent: "claude" }]);
    b.resolve(1, true, "claude");
    await expect(p).resolves.toEqual({ agent: "claude" });
  });

  it("rejects with the shell's message", async () => {
    const { b } = setup();
    const p = b.runPrompt("hello", null);
    b.resolve(1, false, "Cancelled");
    await expect(p).rejects.toThrow("Cancelled");
    b.resolve(1, true, "late"); // ignored
  });

  it("validates before forwarding", () => {
    const { b, requests } = setup();
    expect(() => b.runPrompt("  ", null)).toThrow("empty prompt");
    expect(() => b.runPrompt("x", "rm -rf")).toThrow("invalid agent id");
    expect(requests).toEqual([]);
  });

  it("expires unanswered requests", async () => {
    vi.useFakeTimers();
    const { b, expired } = setup(300_000);
    const p = b.runPrompt("hello", null);
    const check = expect(p).rejects.toThrow("launcher did not answer in time");
    vi.advanceTimersByTime(300_000);
    await check;
    expect(expired).toEqual([1]);
  });

  it("drops open requests when the shell goes away", async () => {
    const { b } = setup();
    const p = b.runPrompt("hello", null);
    b.dropAll();
    await expect(p).rejects.toThrow("launcher dropped the request");
  });
});
