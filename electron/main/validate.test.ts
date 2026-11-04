import { describe, expect, it } from "vitest";
import { MAX_PROMPT_CHARS } from "../shared/contract";
import { validateAgent, validatePrompt } from "./validate";

describe("prompt and agent validation (port of bridge.rs tests)", () => {
  it("validates prompts", () => {
    expect(() => validatePrompt("hello")).not.toThrow();
    expect(() => validatePrompt("  ")).toThrow("empty prompt");
    expect(() => validatePrompt("a".repeat(MAX_PROMPT_CHARS + 1))).toThrow(`prompt longer than ${MAX_PROMPT_CHARS} characters`);
    expect(() => validatePrompt("a\0b")).toThrow("prompt contains NUL");
  });

  it("counts code points like Rust chars, not UTF-16 units", () => {
    expect(() => validatePrompt("😀".repeat(MAX_PROMPT_CHARS))).not.toThrow();
    expect(() => validatePrompt("😀".repeat(MAX_PROMPT_CHARS + 1))).toThrow();
  });

  it("validates agent ids", () => {
    expect(() => validateAgent("claude")).not.toThrow();
    expect(() => validateAgent("my-agent2")).not.toThrow();
    expect(() => validateAgent("rm -rf")).toThrow("invalid agent id");
    expect(() => validateAgent("")).toThrow();
    expect(() => validateAgent("Claude")).toThrow();
    expect(() => validateAgent("a".repeat(33))).toThrow();
  });
});
