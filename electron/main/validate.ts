// Prompt / agent validation for the site bridge and deep links (port of bridge.rs). Pure.

import { MAX_PROMPT_CHARS } from "../shared/contract";

/** Throws Error(message) when the prompt is not acceptable. Length counts Unicode code points (Rust chars). */
export function validatePrompt(prompt: string): void {
  if (prompt.trim() === "") throw new Error("empty prompt");
  if ([...prompt].length > MAX_PROMPT_CHARS) throw new Error(`prompt longer than ${MAX_PROMPT_CHARS} characters`);
  if (prompt.includes("\0")) throw new Error("prompt contains NUL");
}

export function validateAgent(agent: string): void {
  if (!/^[a-z0-9-]{1,32}$/.test(agent)) throw new Error("invalid agent id");
}

export function charCount(s: string): number {
  return [...s].length;
}
