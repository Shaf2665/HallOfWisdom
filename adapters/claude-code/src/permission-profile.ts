/**
 * The fixed, non-negotiable permission and isolation profile every task
 * execution uses. Nothing here is derived from `AgentTaskInput`, browser
 * request data, or any task-controlled field — it is a constant, reviewed
 * once, and the only thing a future change to it should come from is a
 * deliberate edit to this file. See
 * `docs/architecture/0008-claude-code-adapter.md`, "Permission profile",
 * for the reasoning behind each flag, including which CLI flags were
 * verified against the installed CLI's actual `--help` output (2.1.212)
 * rather than assumed from general documentation.
 *
 * `--max-turns` does not exist in the installed CLI version — Phase 9
 * bounds turns Hall-side instead (see `stream-parser.ts`'s
 * `maxMessageCount` and the run's own wall-clock timeout), not through a
 * CLI flag. `--max-budget-usd` is deliberately not used either: it is
 * dollar/API-billing-denominated, which conflates with the billing model
 * this adapter exists specifically to avoid.
 */

/**
 * Why `dontAsk` (not `bypassPermissions`/`--dangerously-skip-permissions`)
 * still enforces `ALLOWED_TOOLS`/`DISALLOWED_TOOLS` below, verified by
 * construction from the installed CLI's own `--help` text (2.1.212) rather
 * than assumed:
 *
 *   --permission-mode <mode>   choices: "acceptEdits", "auto",
 *                               "bypassPermissions", "manual", "dontAsk", "plan"
 *   --dangerously-skip-permissions   "Bypass all permission checks. ..."
 *
 * The CLI exposes `bypassPermissions` as a distinct mode from `dontAsk`,
 * and reserves the "bypass all permission checks" language and the scary,
 * separately-flagged `--dangerously-skip-permissions` for that mode alone.
 * If `dontAsk` also skipped rule enforcement, `bypassPermissions` would be
 * a redundant, confusingly-named duplicate of it — the CLI's own naming
 * only makes sense if `dontAsk` still evaluates the allow/deny rules and
 * merely resolves the outcome automatically instead of prompting a human
 * (who cannot exist in a `-p` non-interactive run anyway). This adapter
 * therefore never uses `bypassPermissions` or either
 * `--dangerously-skip-permissions` flag, by design — see
 * `docs/architecture/0008-claude-code-adapter.md`, "Why bypassPermissions
 * is forbidden", for the full reasoning and its limits (this is
 * verified-by-construction from documented CLI semantics, not by
 * triggering a live denied command against the real CLI).
 */
export const PERMISSION_MODE = "dontAsk";

/**
 * The complete set of tool *categories* loaded into the session at all —
 * anything not listed here does not merely fail a permission check, it
 * does not exist for Claude to attempt. This is a coarser, independent
 * guarantee layered on top of (not a substitute for) the fine-grained
 * `ALLOWED_TOOLS`/`DISALLOWED_TOOLS` rules below: `--tools` controls which
 * built-in tools are even available (per `--help`: "Specify the list of
 * available tools from the built-in set"), while `--allowedTools`/
 * `--disallowedTools` are the same pattern-matched allow/deny rule engine
 * `settings.json`'s `permissions.allow`/`permissions.deny` arrays populate
 * (per `--help`, both accept the identical `"Bash(git *)"`-style syntax).
 * `Bash` must stay in this list — omitting it would make even the
 * whitelisted `git status`/`pnpm test`-style commands unavailable, not
 * just the disallowed ones — but its presence here only makes the Bash
 * *tool* reachable; which individual commands may actually run is decided
 * by `ALLOWED_BASH_COMMANDS` below, not by this list.
 */
const LOADED_TOOL_SET = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] as const;

/**
 * Exact-match only — never a prefix wildcard — so an allowed development
 * command can never be invoked with attacker- or task-influenced extra
 * arguments. Deliberately not `Bash(pnpm *)`: pnpm can execute arbitrary
 * package scripts, so a wildcard here would defeat the entire allowlist.
 */
const ALLOWED_BASH_COMMANDS = [
  "Bash(git status)",
  "Bash(git diff)",
  "Bash(pnpm typecheck)",
  "Bash(pnpm lint)",
  "Bash(pnpm test)",
  "Bash(pnpm build)",
] as const;

const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", ...ALLOWED_BASH_COMMANDS] as const;

/**
 * Explicit, defense-in-depth denials for the specific destructive/
 * exfiltration-shaped operations the spec calls out by name. `dontAsk`
 * plus the allowlist above should already make every one of these
 * unreachable (nothing outside `ALLOWED_BASH_COMMANDS` is allowed), but
 * listing them here means a future accidental widening of the allowlist
 * (e.g. someone adding `Bash(git *)` for convenience) still can't
 * silently re-open exactly these operations.
 */
const DISALLOWED_TOOLS = [
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git reset:*)",
  "Bash(git clean:*)",
  "Bash(git checkout:*)",
  "Bash(git switch:*)",
  "Bash(rm:*)",
  "Bash(rmdir:*)",
  "Bash(del:*)",
  "Bash(Remove-Item:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  "Bash(Invoke-WebRequest:*)",
  "Bash(npm publish:*)",
  "Bash(pnpm publish:*)",
  "Bash(npm install:*)",
  "Bash(pnpm install:*)",
  "Bash(pnpm add:*)",
  "Bash(docker:*)",
  "Bash(ssh:*)",
  "Bash(scp:*)",
] as const;

/**
 * Builds the fixed CLI argument array for one task execution, given only
 * the already-built prompt string. Every element is a separate argv
 * entry — never joined into a shell-interpretable string — matching the
 * `shell: false` process-launch discipline in `process-launcher.ts`.
 */
/**
 * Phase 9.1 correction: `--setting-sources project` was removed entirely
 * (not replaced with `user` or any other value) and `--safe-mode` was
 * added. Neither `.claude/settings.json`, `.claude/settings.local.json`,
 * nor any user-level settings file is a trusted execution-policy source
 * for an adapter-launched task — a task's own working directory is
 * repository-controlled content, no more trusted than the task's own
 * title/description, and a global `~/.claude/settings.json` can carry
 * hooks, an `apiKeyHelper`, MCP servers, and permission additions the
 * operator configured for *interactive* use, none of which this adapter
 * ever wants silently applied to an automated run. `--safe-mode` disables
 * CLAUDE.md auto-loading, skills, plugins, hooks, MCP servers, custom
 * commands/agents, output styles, workflows, and themes wholesale — per
 * the installed CLI's own `--help` text: "Admin-managed (policy) settings
 * still apply. Auth, model selection, built-in tools, and permissions work
 * normally." That last sentence is why this is safe to add: it does not
 * touch subscription auth, and the fixed `--tools`/`--allowedTools`/
 * `--disallowedTools`/`--permission-mode` profile below still applies in
 * full. See `docs/architecture/0008-claude-code-adapter.md`, "Why
 * repository settings are not trusted as adapter policy" and "Why
 * --safe-mode is mandatory", for the full reasoning, including why
 * `--bare` (a different, superficially similar flag that forces API-key
 * billing and would defeat this adapter's subscription-only guarantee) is
 * never used.
 */
export function buildClaudeArgv(prompt: string): readonly string[] {
  return [
    "--print",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    PERMISSION_MODE,
    "--tools",
    LOADED_TOOL_SET.join(","),
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
    "--safe-mode",
    // No --mcp-config is ever passed, so this guarantees zero MCP servers
    // load even from project-level configuration.
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
  ];
}
