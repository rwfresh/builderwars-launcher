// Bridge between the game view (our site) and the shell UI (port of bridge.rs).
//
// Transport: the game preload (electron/preload/game.ts) invokes BRIDGE_CHANNELS; main checks the
// sender (game view, top frame, site origin) in ipc.ts and calls into this module. run_prompt is
// forwarded to the shell UI (which owns the terminal, agent mapping and herdr mode) as an event and
// awaits the shell's answer via `bridgeResolve`. No Electron imports: unit-testable.

import { RUN_PROMPT_ANSWER_TIMEOUT_MS, type RunPromptEvent } from "../shared/contract";
import { charCount, validateAgent, validatePrompt } from "./validate";

interface Pending {
  resolve: (agent: string) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeHooks {
  /** Forward a request to the shell UI (SHELL_EVENTS.bridgeRunPrompt). */
  request(ev: RunPromptEvent): void;
  /** The request timed out: drop the confirmation the shell may still be showing (SHELL_EVENTS.bridgeExpired). */
  expired(id: number): void;
  log(line: string): void;
}

export class PromptBridge {
  private pending = new Map<number, Pending>();
  private next = 0;

  constructor(
    private readonly hooks: BridgeHooks,
    private readonly timeoutMs = RUN_PROMPT_ANSWER_TIMEOUT_MS,
  ) {}

  /** Validates, forwards to the shell and resolves with the agent that ran (rejects with the shell's message). */
  runPrompt(prompt: string, agent: string | null): Promise<{ agent: string }> {
    validatePrompt(prompt);
    if (agent != null) validateAgent(agent);
    const id = ++this.next;
    return new Promise<{ agent: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.hooks.expired(id);
          reject(new Error("launcher did not answer in time"));
        }
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (a) => resolve({ agent: a }), reject, timer });
      this.hooks.log(`[bridge] run_prompt #${id} from game agent=${agent == null ? "None" : JSON.stringify(agent)} (${charCount(prompt)} chars)`);
      this.hooks.request({ id, prompt, agent });
    });
  }

  /** Shell answer: ok -> value is the agent id; !ok -> value is the error message. Unknown ids are ignored. */
  resolve(id: number, ok: boolean, value: string): void {
    this.hooks.log(`[bridge] resolve #${id} ok=${ok} value=${value}`);
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(value);
    else p.reject(new Error(value));
  }

  /** The shell went away (reload/crash): fail every open request. */
  dropAll(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("launcher dropped the request"));
      this.pending.delete(id);
    }
  }
}
