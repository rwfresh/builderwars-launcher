import { describe, expect, it } from "vitest";
import { agentArgv, buildCommand, cdPrefix, chooseAgent, quoteArg, quoteDir, sanitizePrompt, shellKindFromPath } from "./agents";

describe("agent command mapping", () => {
  it("maps each CLI to its initial-prompt syntax", () => {
    expect(agentArgv("claude", "hi")).toEqual(["claude", "hi"]);
    expect(agentArgv("codex", "hi")).toEqual(["codex", "hi"]);
    expect(agentArgv("gemini", "hi")).toEqual(["gemini", "-i", "hi"]);
    expect(agentArgv("grok", "hi")).toEqual(["grok", "hi"]);
    expect(agentArgv("opencode", "hi")).toEqual(["opencode", "--prompt", "hi"]);
  });

  it("keeps a leading dash from becoming a flag", () => {
    expect(agentArgv("claude", "--help me")).toEqual(["claude", " --help me"]);
  });

  it("builds readable commands", () => {
    expect(buildCommand("claude", "hello", "posix")).toBe("claude hello");
    expect(buildCommand("claude", "hello world", "posix")).toBe('claude "hello world"');
    expect(buildCommand("gemini", "make a promo", "posix")).toBe('gemini -i "make a promo"');
    expect(buildCommand("opencode", "x y", "powershell")).toBe("opencode --prompt 'x y'");
  });
});

describe("work directory prefix", () => {
  it("cds into the work dir before starting the agent", () => {
    expect(buildCommand("claude", "hello", "posix", { cwd: "/home/u/BuilderWars", home: "/home/u" })).toBe(
      "cd ~/BuilderWars && claude hello",
    );
    expect(buildCommand("claude", "hi there", "fish", { cwd: "/srv/my bw" })).toBe('cd "/srv/my bw" && claude "hi there"');
    expect(buildCommand("codex", "x", "powershell", { cwd: "C:\\Users\\u\\BuilderWars" })).toBe(
      "Set-Location -LiteralPath 'C:\\Users\\u\\BuilderWars'; codex x",
    );
  });

  it("quotes unusual directories instead of using ~", () => {
    expect(quoteDir("/home/u/it's", "posix", "/home/u")).toBe(`"/home/u/it's"`);
    expect(quoteDir("/home/u", "posix", "/home/u/")).toBe("~");
    expect(cdPrefix("/tmp/$x", "posix")).toBe("cd '/tmp/$x' && ");
  });
});

describe("quoting", () => {
  const nasty = `it's "quoted" $(rm -rf ~) \`id\` $HOME !! \\n back\\slash`;

  it("posix: single-quotes anything with specials and escapes single quotes", () => {
    expect(quoteArg(nasty, "posix")).toBe(`'it'\\''s "quoted" $(rm -rf ~) \`id\` $HOME !! \\n back\\slash'`);
    expect(quoteArg("", "posix")).toBe('""');
    expect(quoteArg("it's", "posix")).toBe(`"it's"`);
    expect(quoteArg("a\nb", "posix")).toBe("'a\nb'");
  });

  it("fish: escapes backslashes and single quotes inside single quotes", () => {
    expect(quoteArg(`it's a\\b $x`, "fish")).toBe(`'it\\'s a\\\\b $x'`);
  });

  it("powershell: doubles straight and typographic single quotes", () => {
    expect(quoteArg("it's $env:HOME", "powershell")).toBe("'it''s $env:HOME'");
    expect(quoteArg("it\u2019s", "powershell")).toBe("'it\u2019\u2019s'");
  });

  it.skipIf(process.platform === "win32")("posix quoting round-trips through bash", async () => {
    const { execFileSync } = await import("node:child_process");
    const quoted = quoteArg(nasty, "posix");
    const out = execFileSync("bash", ["-c", `printf %s ${quoted}`], { encoding: "utf8" });
    expect(out).toBe(nasty);
  });
});

describe("sanitizePrompt", () => {
  it("strips control chars and escape sequences, keeps newlines", () => {
    expect(sanitizePrompt("a\x1b[31mred\x07\tb\r\nc")).toBe("a[31mred  b\nc");
  });
});

describe("chooseAgent", () => {
  const installed = ["codex", "claude"];
  it("honours an installed requested agent", () => {
    expect(chooseAgent("claude", null, installed)).toEqual({ agent: "claude" });
  });
  it("errors for unknown or missing agents", () => {
    expect(chooseAgent("vim", null, installed)).toHaveProperty("error");
    expect(chooseAgent("gemini", null, installed)).toHaveProperty("error");
  });
  it("falls back to the default, then the first installed", () => {
    expect(chooseAgent(null, "claude", installed)).toEqual({ agent: "claude" });
    expect(chooseAgent(undefined, "gemini", installed)).toEqual({ agent: "codex" });
    expect(chooseAgent(null, null, [])).toHaveProperty("error");
  });
});

describe("shellKindFromPath", () => {
  it("detects shells", () => {
    expect(shellKindFromPath("/usr/bin/fish")).toBe("fish");
    expect(shellKindFromPath("/bin/zsh")).toBe("posix");
    expect(shellKindFromPath("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
    expect(shellKindFromPath("pwsh")).toBe("powershell");
  });
});
