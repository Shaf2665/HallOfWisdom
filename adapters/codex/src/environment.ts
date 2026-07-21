/**
 * Builds the environment a Codex child process (detection or task
 * execution) actually receives. Deliberately an allowlist, not "inherit
 * everything, then strip the bad ones" — see
 * `adapters/claude-code/src/environment.ts` for the general reasoning this
 * mirrors, and `docs/architecture/0009-codex-adapter.md`, "Environment
 * sanitization", for the Codex-specific policy.
 *
 * The same sanitized environment is used for both `detect()`'s
 * `codex login status` call and the real task's `codex exec` call — a
 * verified-ChatGPT detection result must actually predict what auth
 * source the task itself uses.
 *
 * `CODEX_HOME` is preserved when present: it is where the operator's own
 * `codex login` already wrote ChatGPT credentials (see `codex doctor
 * --json`'s `auth.credentials.details["auth file"]`, observed during
 * Phase 10 reconnaissance to live under `%CODEX_HOME%\auth.json`). Without
 * it (or without `HOME`/`USERPROFILE` resolving to the same location),
 * Codex would fail to find the operator's already-established ChatGPT
 * login — a spurious "logged out" result, not a genuine one. This adapter
 * never reads the contents of that location itself; it only ever lets the
 * *installed CLI* consult its own credential store.
 */

// Platform/user-environment fields preserved when present, matched
// case-insensitively (Windows env var names are case-insensitive; Node's
// process.env keys preserve whatever case the OS reports them in).
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
  // Where the installed CLI's own `codex login` already wrote ChatGPT
  // credentials — never a browser- or task-set value. See the module doc
  // comment above.
  "CODEX_HOME",
] as const;

/**
 * Variable names that must never reach a spawned Codex process because
 * each one can silently redirect Codex to a different billing/
 * authentication source than the operator's verified ChatGPT login, or to
 * a different model provider entirely. Checked as a defense-in-depth
 * assertion after allowlist construction (see `buildChildEnvironment`'s
 * final filter step) — the allowlist above should make this list
 * unreachable in practice, but an explicit, tested block is cheaper than
 * trusting that invariant silently.
 */
const BLOCKED_ENV_KEY_SUBSTRINGS = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "AZURE_OPENAI",
  "AZURE_",
  "OPENAI_API_BASE",
  "OPENAI_API_TYPE",
  "CODEX_OSS",
  "CODEX_PROFILE",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
] as const;

function isBlockedKey(key: string): boolean {
  const upper = key.toUpperCase();
  return BLOCKED_ENV_KEY_SUBSTRINGS.some((blocked) => upper.includes(blocked));
}

/**
 * Builds a fresh, minimal environment object for a Codex child process.
 * Never mutates `parentEnv`. Returns only string values (Node's
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
    // it is still caught here rather than silently reaching a child
    // process.
    if (isBlockedKey(safeKey)) continue;
    const value = lowerCaseIndex.get(safeKey.toLowerCase());
    if (value !== undefined) {
      result[safeKey] = value;
    }
  }

  return result;
}

/** True if any billing/provider-changing variable is present in the given environment. Test-only helper. */
export function containsBlockedEnvironmentKey(env: Readonly<Record<string, string>>): boolean {
  return Object.keys(env).some(isBlockedKey);
}
