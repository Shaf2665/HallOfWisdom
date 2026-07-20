import { describe, expect, it } from "vitest";
import { buildClaudeArgv, PERMISSION_MODE } from "./permission-profile.js";

describe("buildClaudeArgv", () => {
  it("passes the prompt as exactly one argv element following --print", () => {
    const argv = buildClaudeArgv("hello world && rm -rf /");
    const printIndex = argv.indexOf("--print");
    expect(argv[printIndex + 1]).toBe("hello world && rm -rf /");
  });

  it("uses the fixed dontAsk permission mode", () => {
    expect(PERMISSION_MODE).toBe("dontAsk");
    const argv = buildClaudeArgv("x");
    const modeIndex = argv.indexOf("--permission-mode");
    expect(argv[modeIndex + 1]).toBe("dontAsk");
  });

  it("never includes bypassPermissions in any form", () => {
    const argv = buildClaudeArgv("x");
    expect(argv.join(" ")).not.toMatch(/bypass-?[Pp]ermissions/);
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--allow-dangerously-skip-permissions");
  });

  it("never includes a broad Bash(*) rule", () => {
    const argv = buildClaudeArgv("x");
    expect(argv).not.toContain("Bash(*)");
  });

  it("never includes a broad Bash(pnpm *) rule", () => {
    const argv = buildClaudeArgv("x");
    expect(argv).not.toContain("Bash(pnpm *)");
    expect(argv.some((entry) => /^Bash\(pnpm \*\)$/.test(entry))).toBe(false);
  });

  it("allows only exact, narrowly scoped Bash development commands", () => {
    const argv = buildClaudeArgv("x");
    const allowedIndex = argv.indexOf("--allowedTools");
    const disallowedIndex = argv.indexOf("--disallowedTools");
    const allowedEntries = argv.slice(allowedIndex + 1, disallowedIndex);
    const bashEntries = allowedEntries.filter((entry) => entry.startsWith("Bash("));
    expect(bashEntries).toEqual([
      "Bash(git status)",
      "Bash(git diff)",
      "Bash(pnpm typecheck)",
      "Bash(pnpm lint)",
      "Bash(pnpm test)",
      "Bash(pnpm build)",
    ]);
  });

  it("explicitly denies git push, commit, reset, clean, checkout, switch", () => {
    const argv = buildClaudeArgv("x");
    for (const denied of [
      "Bash(git push:*)",
      "Bash(git commit:*)",
      "Bash(git reset:*)",
      "Bash(git clean:*)",
      "Bash(git checkout:*)",
      "Bash(git switch:*)",
    ]) {
      expect(argv).toContain(denied);
    }
  });

  it("explicitly denies destructive filesystem and network commands", () => {
    const argv = buildClaudeArgv("x");
    for (const denied of [
      "Bash(rm:*)",
      "Bash(rmdir:*)",
      "Bash(del:*)",
      "Bash(Remove-Item:*)",
      "Bash(curl:*)",
      "Bash(wget:*)",
      "Bash(Invoke-WebRequest:*)",
    ]) {
      expect(argv).toContain(denied);
    }
  });

  it("explicitly denies publishing, package installation, Docker, SSH, SCP", () => {
    const argv = buildClaudeArgv("x");
    for (const denied of [
      "Bash(npm publish:*)",
      "Bash(pnpm publish:*)",
      "Bash(npm install:*)",
      "Bash(pnpm install:*)",
      "Bash(pnpm add:*)",
      "Bash(docker:*)",
      "Bash(ssh:*)",
      "Bash(scp:*)",
    ]) {
      expect(argv).toContain(denied);
    }
  });

  it("restricts the loaded tool set to exactly Read, Glob, Grep, Edit, Write, Bash", () => {
    const argv = buildClaudeArgv("x");
    const toolsIndex = argv.indexOf("--tools");
    expect(argv[toolsIndex + 1]).toBe("Read,Glob,Grep,Edit,Write,Bash");
  });

  it("never passes --add-dir, --agent, --agents, --mcp-config, --model, --system-prompt, or --max-turns", () => {
    const argv = buildClaudeArgv("x");
    for (const forbidden of [
      "--add-dir",
      "--agent",
      "--agents",
      "--mcp-config",
      "--model",
      "--system-prompt",
      "--system-prompt-file",
      "--append-system-prompt",
      "--append-system-prompt-file",
      "--max-turns",
      "--max-budget-usd",
      "--bg",
      "--background",
      "--remote-control",
      "--bare",
      "--session-id",
      "--resume",
      "--plugin-dir",
      "--plugin-url",
    ]) {
      expect(argv).not.toContain(forbidden);
    }
  });

  it("disables Claude in Chrome integration and slash commands", () => {
    const argv = buildClaudeArgv("x");
    expect(argv).toContain("--no-chrome");
    expect(argv).toContain("--disable-slash-commands");
  });

  it("enforces zero MCP servers via --strict-mcp-config with no --mcp-config supplied", () => {
    const argv = buildClaudeArgv("x");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("--mcp-config");
  });

  it("requests stream-json output with verbose detail", () => {
    const argv = buildClaudeArgv("x");
    expect(argv).toContain("--output-format");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv).toContain("--verbose");
  });

  it("produces the same argv for the same prompt (deterministic, no hidden randomness)", () => {
    expect(buildClaudeArgv("same")).toEqual(buildClaudeArgv("same"));
  });
});

describe("buildClaudeArgv — Phase 9.1 configuration isolation profile", () => {
  it("always includes --safe-mode", () => {
    const argv = buildClaudeArgv("x");
    expect(argv).toContain("--safe-mode");
  });

  it("never passes --setting-sources at all — not project, not user, not local", () => {
    const argv = buildClaudeArgv("x");
    expect(argv).not.toContain("--setting-sources");
  });

  it("never passes the literal string 'project' as a standalone argv element", () => {
    // A substring scan would false-positive on the prompt's own "Project:"
    // line — this checks exact argv element equality instead.
    const argv = buildClaudeArgv("x");
    expect(argv).not.toContain("project");
  });

  it("always includes --no-session-persistence", () => {
    const argv = buildClaudeArgv("x");
    expect(argv).toContain("--no-session-persistence");
  });

  it("keeps the fixed Hall-controlled --tools/--allowedTools/--disallowedTools alongside --safe-mode", () => {
    const argv = buildClaudeArgv("x");
    expect(argv).toContain("--tools");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("--safe-mode");
  });

  it("keeps shell-injection and prompt-as-one-argument guarantees alongside the new isolation flags", () => {
    const argv = buildClaudeArgv("dangerous `rm -rf /` && echo pwned");
    const printIndex = argv.indexOf("--print");
    expect(argv[printIndex + 1]).toBe("dangerous `rm -rf /` && echo pwned");
    expect(argv.filter((entry) => entry === "--print")).toHaveLength(1);
  });

  it("is unaffected by task-text-shaped attempts to inject isolation-relevant flags into the prompt", () => {
    const argv = buildClaudeArgv(
      "--setting-sources user --bare --dangerously-skip-permissions --mcp-config evil.json",
    );
    // The malicious text is present, but only as the literal prompt string
    // (one argv element after --print) — never as separate argv entries.
    const printIndex = argv.indexOf("--print");
    expect(argv[printIndex + 1]).toContain("--setting-sources");
    const withoutPrompt = [...argv.slice(0, printIndex + 1), ...argv.slice(printIndex + 2)];
    expect(withoutPrompt).not.toContain("--setting-sources");
    expect(withoutPrompt).not.toContain("--bare");
    expect(withoutPrompt).not.toContain("--dangerously-skip-permissions");
    expect(withoutPrompt).not.toContain("--mcp-config");
  });
});
