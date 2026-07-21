/**
 * Safe, load-bearing classification of `codex login status` output. Only
 * `"chatgpt"` may ever permit task execution — every other value is a
 * best-effort diagnostic label, not a security gate. See
 * `docs/architecture/0009-codex-adapter.md`, "Authentication output
 * hygiene".
 */
export type AuthenticationKind =
  "chatgpt" | "api_key" | "access_token" | "logged_out" | "ambiguous";

/**
 * The only shape any code outside this module is ever allowed to see for
 * a `codex login status` result. Deliberately excludes every identifying
 * field (account email, workspace/org name, `CODEX_HOME`, credential file
 * paths) even though other Codex CLI commands (e.g. `codex doctor
 * --json`) do report them — this type is structurally incapable of
 * carrying them, and this adapter never calls `codex doctor` at all.
 */
export interface SafeAuthClassification {
  readonly authenticationKind: AuthenticationKind;
  /**
   * The only field `detectCodex`/`startTask` may treat as a security
   * gate. True only when the output matched the one recognized
   * "logged in with ChatGPT" shape actually observed against the
   * installed CLI (0.144.4) during Phase 10 reconnaissance:
   * `"Logged in using ChatGPT"`.
   */
  readonly chatgptVerified: boolean;
}

const MAX_AUTH_OUTPUT_LENGTH = 10_000;

/**
 * `codex login status` has no `--json` mode (confirmed via `codex login
 * status --help` during Phase 10 reconnaissance) — this adapter must
 * classify its plain, human-readable text. Only the exact, real, positive
 * shape below has actually been observed against the installed CLI. The
 * other patterns are a best-effort, conservative guess at how the CLI
 * would report a non-ChatGPT or logged-out state, based on the flag names
 * `codex login --help` documents (`--with-api-key`, `--with-access-token`)
 * — deliberately never triggered live to avoid disturbing the operator's
 * real ChatGPT session. Because these negative-state patterns are
 * unverified, any output that does not clearly match one of them —
 * including a plausible-looking but unrecognized string — classifies as
 * `"ambiguous"` with `chatgptVerified: false` rather than being guessed
 * into a specific category. See
 * `docs/architecture/0009-codex-adapter.md`, "Authentication output
 * hygiene", for the disclosed scope of this verification gap.
 */
const CHATGPT_PATTERN = /logged in using chatgpt/i;
const API_KEY_PATTERN = /logged in using an? api key|api key/i;
const ACCESS_TOKEN_PATTERN = /access token/i;
const LOGGED_OUT_PATTERN = /not logged in|logged out|no.*credentials/i;

/**
 * Parses and immediately reduces raw `codex login status` stdout to a
 * `SafeAuthClassification`. Never throws. The raw string is local to this
 * function and never returned, logged, or embedded in a thrown error — it
 * goes out of scope (and becomes garbage-collectable) the moment this
 * function returns. No caller of this function ever receives anything but
 * the fixed, safe shape above.
 */
export function parseLoginStatusOutput(rawStdout: string): SafeAuthClassification {
  if (rawStdout.length > MAX_AUTH_OUTPUT_LENGTH) {
    return { authenticationKind: "ambiguous", chatgptVerified: false };
  }

  const trimmed = rawStdout.trim();

  if (CHATGPT_PATTERN.test(trimmed)) {
    return { authenticationKind: "chatgpt", chatgptVerified: true };
  }
  if (LOGGED_OUT_PATTERN.test(trimmed)) {
    return { authenticationKind: "logged_out", chatgptVerified: false };
  }
  if (ACCESS_TOKEN_PATTERN.test(trimmed)) {
    return { authenticationKind: "access_token", chatgptVerified: false };
  }
  if (API_KEY_PATTERN.test(trimmed)) {
    return { authenticationKind: "api_key", chatgptVerified: false };
  }
  return { authenticationKind: "ambiguous", chatgptVerified: false };
}
