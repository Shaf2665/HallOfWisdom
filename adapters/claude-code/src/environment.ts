/**
 * Builds the environment a Claude Code child process (task execution or
 * detection) actually receives. Deliberately an allowlist, not "inherit
 * everything, then strip the bad ones": a denylist can only ever block
 * variable names it was told about in advance, while an allowlist is safe
 * by construction against anything it was never told to include — env var
 * names Anthropic adds in a future CLI release for a new billing source
 * are blocked automatically here, not only after someone remembers to add
 * them to a blocklist.
 *
 * The same sanitized environment is used for both `detect()`'s
 * `claude auth status` call and the real task's `claude -p ...` call — see
 * `docs/architecture/0008-claude-code-adapter.md`, "Why detection and
 * execution share one sanitized environment": if they used different
 * environments, a verified-subscription detection result would not
 * actually predict what auth source the task itself would use.
 */

// Platform/user-environment fields preserved when present, matched
// case-insensitively (Windows env var names are case-insensitive; Node's
// process.env keys preserve whatever case the OS reports them in).
const SAFE_ENV_KEYS = [
  "PATH",
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
  // Deliberately supported and documented: redirects where the CLI looks
  // for its already-established local config/auth, never a browser-set
  // value — see the doc comment on `ClaudeCodeAdapterConfig.claudeConfigDir`.
  "CLAUDE_CONFIG_DIR",
] as const;

/**
 * Variable names that must never reach a spawned Claude Code process
 * because each one can silently redirect Claude Code to a different
 * billing/authentication source than the operator's verified subscription
 * login. Checked as a defense-in-depth assertion after allowlist
 * construction (see `buildChildEnvironment`'s final filter step) — the
 * allowlist above should make this list unreachable in practice, but an
 * explicit, tested block is cheaper than trusting that invariant silently.
 */
const BLOCKED_ENV_KEY_SUBSTRINGS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_",
  "GOOGLE_",
  "GCLOUD_",
  "CLOUD_ML_REGION",
  "VERTEX_",
  "AZURE_",
  "FOUNDRY_",
] as const;

function isBlockedKey(key: string): boolean {
  const upper = key.toUpperCase();
  return BLOCKED_ENV_KEY_SUBSTRINGS.some((blocked) => upper.includes(blocked));
}

/**
 * Builds a fresh, minimal environment object for a Claude Code child
 * process. Never mutates `parentEnv`. Returns only string values (Node's
 * `ProcessEnv` allows `undefined`; those are dropped rather than passed
 * through as the literal string `"undefined"`).
 */
export function buildChildEnvironment(
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
    // Defense-in-depth: the allowlist above should make this check a
    // no-op, but a future edit to SAFE_ENV_KEYS that accidentally widens
    // it (e.g. adding "AWS_REGION" for an unrelated reason) is still
    // caught here rather than silently reaching a child process.
    if (isBlockedKey(safeKey)) continue;
    const value = lowerCaseIndex.get(safeKey.toLowerCase());
    if (value !== undefined) {
      result[safeKey] = value;
    }
  }

  return result;
}

/** True if any billing-changing variable is present in the given environment. Test-only helper. */
export function containsBlockedEnvironmentKey(env: Readonly<Record<string, string>>): boolean {
  return Object.keys(env).some(isBlockedKey);
}
