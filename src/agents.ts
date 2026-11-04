// Agent CLI command mapping and shell quoting. Pure, unit-tested.

/** Agent CLIs the launcher knows how to start with an initial prompt. Order = detection order. */
export const AGENT_IDS = ["claude", "codex", "gemini", "grok", "opencode"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  grok: "Grok CLI",
  opencode: "opencode",
};

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === "string" && (AGENT_IDS as readonly string[]).includes(v);
}

/**
 * argv for an interactive session with an initial prompt. Verified on the dev machine (Nov 2026):
 * `claude "<p>"`, `codex "<p>"`, `gemini -i "<p>"`, `grok "<p>"`, `opencode --prompt "<p>"`.
 */
export function agentArgv(agent: AgentId, prompt: string): string[] {
  // A prompt starting with "-" would be parsed as a flag; a leading space keeps it positional.
  const p = prompt.startsWith("-") ? ` ${prompt}` : prompt;
  switch (agent) {
    case "claude":
      return ["claude", p];
    case "codex":
      return ["codex", p];
    case "gemini":
      return ["gemini", "-i", p];
    case "grok":
      return ["grok", p];
    case "opencode":
      return ["opencode", "--prompt", p];
  }
}

export type ShellKind = "posix" | "fish" | "powershell";

export function shellKindFromPath(shell: string): ShellKind {
  const base = shell.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "") ?? "";
  if (base === "fish") return "fish";
  if (base === "pwsh" || base === "powershell") return "powershell";
  return "posix";
}

/**
 * Normalise a prompt before it is typed into a terminal: drop control characters (escape sequences
 * could drive the terminal or the line editor), turn tabs into spaces (tab triggers completion),
 * normalise newlines to \n. Newlines are kept: inside quotes the shell reads them as part of the
 * argument (continuation prompt), they do not submit the command.
 */
export function sanitizePrompt(prompt: string): string {
  return prompt
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u2028\u2029]/g, "\n");
}

const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
// Characters with no special meaning inside double quotes in bash/zsh/fish (no $ ` \ " ! newline).
const DQ_SAFE = /^[^$`\\"!\n]*$/;

/** Quote one argument for the given shell. Result is safe to type at an interactive prompt. */
export function quoteArg(arg: string, kind: ShellKind): string {
  if (kind === "powershell") {
    if (/^[A-Za-z0-9_./-]+$/.test(arg)) return arg;
    // Single-quoted strings are literal; ' is escaped by doubling. PowerShell also treats the
    // typographic quotes U+2018/U+2019/U+201A/U+201B as single quotes, so double those too.
    return `'${arg.replace(/['\u2018\u2019\u201a\u201b]/g, (q) => q + q)}'`;
  }
  if (arg !== "" && POSIX_SAFE.test(arg)) return arg;
  // Prefer double quotes when nothing inside needs escaping (reads naturally: claude "hello").
  if (DQ_SAFE.test(arg)) return `"${arg}"`;
  // Single quotes are literal in sh/bash/zsh (no history expansion inside them either).
  // fish: \' inside single quotes is an escaped quote and \\ a backslash, everything else literal.
  if (kind === "fish") return `'${arg.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Quote a directory for `cd`, using `~/...` when it is under home and needs no quoting (readable). */
export function quoteDir(dir: string, kind: ShellKind, home?: string): string {
  if (kind !== "powershell" && home) {
    const h = home.replace(/\/+$/, "");
    if (dir === h) return "~";
    if (dir.startsWith(`${h}/`)) {
      const rest = dir.slice(h.length + 1);
      if (POSIX_SAFE.test(rest)) return `~/${rest}`;
    }
  }
  return quoteArg(dir, kind);
}

/** `cd <dir> && ` (or the PowerShell equivalent) so the agent starts in the work directory. */
export function cdPrefix(dir: string, kind: ShellKind, home?: string): string {
  if (kind === "powershell") return `Set-Location -LiteralPath ${quoteArg(dir, kind)}; `;
  // `&&` works in sh/bash/zsh and fish >= 3.0.
  return `cd ${quoteDir(dir, kind, home)} && `;
}

export function buildCommand(
  agent: AgentId,
  prompt: string,
  kind: ShellKind,
  opts: { cwd?: string; home?: string } = {},
): string {
  const argv = agentArgv(agent, sanitizePrompt(prompt));
  const line = argv.map((a, i) => (i === 0 ? a : quoteArg(a, kind))).join(" ");
  return opts.cwd ? cdPrefix(opts.cwd, kind, opts.home) + line : line;
}

/**
 * Pick the agent: the requested one if installed, else the settings default if installed, else the
 * first installed. Returns an error string when the request names an agent that is not installed.
 */
export function chooseAgent(
  requested: string | null | undefined,
  defaultAgent: string | null | undefined,
  installed: readonly string[],
): { agent: AgentId } | { error: string } {
  if (requested != null && requested !== "") {
    if (!isAgentId(requested)) return { error: `unknown agent "${requested}"` };
    if (!installed.includes(requested)) return { error: `${AGENT_LABELS[requested]} is not installed (not on PATH)` };
    return { agent: requested };
  }
  if (isAgentId(defaultAgent) && installed.includes(defaultAgent)) return { agent: defaultAgent };
  const first = installed.find(isAgentId);
  return first ? { agent: first } : { error: "no supported agent CLI found on PATH (claude, codex, gemini, grok, opencode)" };
}
