/**
 * Builds a minimal, allowlisted environment for a `git` child process —
 * same allowlist-not-blocklist policy as
 * `adapters/codex/src/environment.ts` (never "inherit everything, then
 * strip the bad ones"). Every `git` invocation this module issues is a
 * local, read-only or worktree-administrative command (`rev-parse`,
 * `status`, `worktree add/remove/prune`, `diff --numstat`) — none needs
 * network access or credentials, so this allowlist is deliberately
 * narrower than the Codex/Claude Code adapters' (no `CODEX_HOME`-style
 * credential-location entries).
 */
const SAFE_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;

/**
 * Fixed overrides applied after the allowlist, regardless of what the
 * parent process's environment contains: `GIT_TERMINAL_PROMPT=0` makes
 * `git` fail immediately instead of hanging on any credential prompt
 * (defense-in-depth — none of these commands should ever need one, since
 * they never touch a remote); `GIT_PAGER`/`PAGER=cat` and
 * `GIT_CONFIG_NOSYSTEM`/`GIT_OPTIONAL_LOCKS=0` keep output
 * non-interactive and deterministic; `NO_COLOR=1` keeps `git`'s plumbing
 * output free of ANSI escape codes this module's regex-based parsing
 * would otherwise have to strip.
 */
const FIXED_OVERRIDES: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  NO_COLOR: "1",
};

/**
 * Builds a fresh, minimal environment object for a `git` child process.
 * Never mutates `parentEnv`. Returns only string values (Node's
 * `ProcessEnv` allows `undefined`; those are dropped rather than passed
 * through as the literal string `"undefined"`).
 */
export function buildGitChildEnvironment(
  parentEnv: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const lowerCaseIndex = new Map<string, string>();
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined) {
      lowerCaseIndex.set(key.toLowerCase(), value);
    }
  }

  const result: Record<string, string> = {};
  for (const safeKey of SAFE_ENV_KEYS) {
    const value = lowerCaseIndex.get(safeKey.toLowerCase());
    if (value !== undefined) {
      result[safeKey] = value;
    }
  }

  return { ...result, ...FIXED_OVERRIDES };
}
