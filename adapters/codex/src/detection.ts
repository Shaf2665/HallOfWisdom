import { tmpdir } from "node:os";
import type { AgentDetectionResult } from "@hall-of-wisdom/agent-adapter-sdk";
import type { CapabilityObservation } from "@hall-of-wisdom/protocol";
import { resolveCodexExecutable, type FileSystemProbe } from "./executable-resolver.js";
import { buildChildEnvironment, hasBlockedBillingEnvironmentKey } from "./environment.js";
import { runBoundedProcess } from "./bounded-process.js";
import type { ProcessSpawner } from "./process-spawner.js";
import { getEnvValueCaseInsensitive } from "./env-lookup.js";
import { parseLoginStatusOutput } from "./auth-classification.js";
import {
  fetchCodexExecHelpText,
  matchesIsolationFlags,
  matchesTrustedLocalFlags,
} from "./cli-compatibility.js";

/**
 * Phase 10.2 — the trusted-local preconditions `detectCodex` must verify
 * before it may ever return `availability: "available"`. Every field here
 * is supplied by the composition root from constructor-time server
 * configuration only — never from anything browser-, task-, or
 * REST-request-controlled. See `docs/architecture/0010-paperclip-compatible-codex-mode.md`.
 */
export interface TrustedLocalDetectionOptions {
  /** `--enable-codex-trusted-local` at Hall Core startup. Default false. */
  readonly enabled: boolean;
  /** True only when Hall Core is bound to loopback only (see `LOCAL_ONLY_HOST` in apps/server). */
  readonly loopbackBound: boolean;
  /** The operator-configured, already-validated Hall Core workspace root. */
  readonly workspaceRoot: string;
}

export interface DetectionOptions {
  readonly platform: NodeJS.Platform;
  readonly parentEnv: Readonly<NodeJS.ProcessEnv>;
  readonly fs: FileSystemProbe;
  readonly spawner: ProcessSpawner;
  readonly binaryName?: string;
  readonly versionTimeoutMs?: number;
  readonly authTimeoutMs?: number;
  readonly helpTimeoutMs?: number;
  /** Phase 10.3 — see `DEFAULT_VERSION_RETRY_DELAY_MS`'s doc comment. */
  readonly versionRetryDelayMs?: number;
  readonly trustedLocal?: TrustedLocalDetectionOptions;
}

const DEFAULT_VERSION_TIMEOUT_MS = 5000;
const DEFAULT_AUTH_TIMEOUT_MS = 5000;
const MAX_DETECTED_VERSION_LENGTH = 64;
/**
 * Phase 10.3 — bounded delay before the single allowed retry of the
 * version/start probe. Short enough that a genuinely-broken installation
 * still fails fast; long enough to ride out the one-off cold-start spawn
 * flake observed live during Phase 10.2's real verification passes
 * (Task #74, Task #75) — both times, `--version` failed to start on the
 * very first call after Hall Core's own process started, then succeeded
 * immediately on an identical second call. Configurable via
 * `DetectionOptions.versionRetryDelayMs` purely so tests can override it
 * to a small value and drive it with `vi.useFakeTimers()`, the same
 * pattern already used for `versionTimeoutMs`/`authTimeoutMs`/
 * `helpTimeoutMs` elsewhere in this module and for every timer in
 * `codex-run.ts` — never so production behavior itself needs tuning.
 */
const DEFAULT_VERSION_RETRY_DELAY_MS = 250;

/**
 * Phase 10.3 — internal-only failure classification, documented here for
 * clarity and used to decide the one retry below; never exposed through
 * `AgentDetectionResult` (the public contract's `availability`/
 * `diagnosticMessage` pair is unchanged) and never derived by matching
 * against a diagnostic *message* string — every branch below reads a
 * structured field (`spawnError`, `timedOut`, `exitCode`,
 * `authenticationKind`, `chatgptVerified`, a boolean flag) directly off
 * the bounded-process result or classifier output that produced it.
 *
 * - `executable_not_found` — `resolveCodexExecutable` found nothing on
 *   PATH. Never retried: retrying an unresolved path cannot resolve it.
 * - `process_start_failed` — the `--version` spawn itself failed
 *   (`BoundedProcessResult.spawnError` set). **Retried once.**
 * - `process_timeout` — the `--version` process did not exit within
 *   `versionTimeoutMs` (`BoundedProcessResult.timedOut`). **Retried once.**
 * - `malformed_version` — `--version` exited non-zero, or exited zero
 *   with output `extractVersion` could not parse into a usable string.
 *   Never retried: a real, completed process already answered.
 * - `unsupported_version`/`unsupported_flags` — the version floor or the
 *   `codex exec --help` marker scan failed (`cli-compatibility.ts`).
 *   Never retried: this is an installation-compatibility fact, not a
 *   transient spawn failure, and retrying spends an extra process for no
 *   possible different outcome.
 * - `login_status_failed` — the `login status` spawn itself failed or
 *   timed out. Never retried in this phase: unlike the version probe,
 *   Phase 10.2 real verification never observed this flake on
 *   `login status`, and retrying an authentication-adjacent command is
 *   exactly the kind of "retry after a security-relevant step" the
 *   kickoff's restriction list forbids speculatively adding.
 * - `logged_out`/`api_key_auth`/`access_token_auth`/`ambiguous_auth` —
 *   `parseLoginStatusOutput`'s classification. Never retried: these are
 *   real, safely-classified answers, not failures to get an answer.
 * - `trusted_local_not_enabled` — `options.trustedLocal?.enabled` is not
 *   `true`, or one of its own preconditions failed. Never retried: a
 *   constructor-time configuration fact cannot change mid-detection.
 * - `available` — every check passed.
 */

// Exported (not just module-private) so codex-adapter.ts's
// failureCodeForUnavailableDetection can map each fixed, known-safe
// diagnostic string to a distinct, more specific failure code than the
// single "unsupported" availability value alone would allow — these are
// compared by reference/value against a small fixed constant set, never
// against arbitrary or provider-controlled text.
export const UNVERIFIED_CHATGPT_MESSAGE = "Codex authentication could not be verified safely.";
export const NOT_CHATGPT_MESSAGE = "Codex authentication is not ChatGPT-based.";
export const UNSUPPORTED_ISOLATION_PROFILE_MESSAGE =
  "Installed Codex cannot guarantee the required isolated execution profile.";
/**
 * Phase 10.1 correction: the three real, user-approved task executions
 * performed during Phase 10 reconnaissance never successfully modified a
 * file — every write attempt was rejected by the local sandbox, even
 * after the missing `approval_policy` config key was identified and
 * fixed (see `docs/architecture/0009-codex-adapter.md`, "Real
 * smoke-test results" and "Capability and availability policy"). Until a
 * real file edit genuinely succeeds in a later, explicitly approved
 * phase, this adapter must never advertise itself as a fully available
 * coding agent — `detectCodex` therefore never returns
 * `availability: "available"`. Every check that would previously have
 * reached that outcome (installed, isolation-flag-verified,
 * ChatGPT-authenticated) instead returns this fixed, conservative
 * result. Installation and authentication problems still report their
 * own accurate, more specific status (`unavailable`/`logged_out`/other
 * `unsupported` branches above) — only the single "everything checks out"
 * outcome is capped.
 */
export const UNVERIFIED_EXECUTION_CAPABILITY_MESSAGE =
  "Codex file-edit execution is not verified in the current sandbox.";

/**
 * Phase 10.2 — trusted-local diagnostics. Each is a small, fixed, hand-
 * authored constant (never raw process output, never an executable path,
 * account detail, or CODEX_HOME value), matching the safety discipline
 * every other diagnostic constant in this file already follows.
 */
export const TRUSTED_LOCAL_NOT_LOOPBACK_MESSAGE =
  "Codex trusted-local execution requires Hall Core to be bound to loopback only.";
export const TRUSTED_LOCAL_WORKSPACE_NOT_CONFIGURED_MESSAGE =
  "Codex trusted-local execution requires a configured workspace root.";
export const TRUSTED_LOCAL_BILLING_ENV_BLOCKED_MESSAGE =
  "Codex trusted-local execution was refused because a billing-changing environment variable is present.";
export const TRUSTED_LOCAL_FLAG_UNSUPPORTED_MESSAGE =
  "Installed Codex cannot guarantee the required trusted-local execution profile.";
/**
 * The only diagnostic message this adapter ever attaches to an
 * `availability: "available"` result. Deliberately does not use the words
 * "sandboxed" or "restricted" — trusted-local mode bypasses Codex's
 * internal sandbox and approval enforcement outright; describing it as
 * sandboxed would be false. Never names the Windows sandbox account,
 * executable path, or CODEX_HOME.
 */
export const TRUSTED_LOCAL_AVAILABLE_MESSAGE =
  "Trusted-local mode: Codex sandbox and approval protections are bypassed. Codex runs with the Hall Core user's filesystem permissions.";

/**
 * Phase 11 — true regardless of this machine's current CLI/auth/sandbox
 * state: JSONL stream mapping and process-tree cancellation are proven by
 * this adapter's own deterministic test suite, not by anything `detect()`
 * observes live. Reused on every non-`available` branch below.
 */
const BASELINE_OBSERVATIONS: CapabilityObservation[] = [
  {
    capability: "structured.events",
    status: "verified",
    safeSummary: "Verified by this adapter's deterministic stream-parsing tests.",
    evidence: "deterministic_test",
  },
  {
    capability: "cancellation",
    status: "verified",
    safeSummary: "Verified by this adapter's deterministic process-tree cancellation tests.",
    evidence: "deterministic_test",
  },
];

/**
 * Phase 11 — used only for the branches where Hall has actually diagnosed
 * *why* file-editing execution cannot be trusted right now (the Windows
 * sandbox account's write restriction in strict mode, or one specific
 * trusted-local precondition failing) — `restricted`, not merely
 * `unverified`, because there is a known, environment-probed reason, not
 * just an absence of evidence.
 */
const RESTRICTED_FILE_EDIT_OBSERVATIONS: CapabilityObservation[] = (
  ["project.read", "project.edit", "command.execute", "git.inspect"] as const
).map((capability) => ({
  capability,
  status: "restricted",
  safeSummary:
    "Codex is designed to support this, but it is not currently trusted on this machine.",
  evidence: "environment_probe",
}));

function unavailable(diagnosticMessage: string): AgentDetectionResult {
  return {
    installed: false,
    availability: "unavailable",
    diagnosticMessage,
    executionTrust: "unavailable",
    capabilityObservations: BASELINE_OBSERVATIONS,
  };
}

function unsupported(diagnosticMessage: string, detectedVersion?: string): AgentDetectionResult {
  const result: AgentDetectionResult = {
    installed: true,
    availability: "unsupported",
    diagnosticMessage,
    executionTrust: "unavailable",
    capabilityObservations: BASELINE_OBSERVATIONS,
  };
  return detectedVersion !== undefined ? { ...result, detectedVersion } : result;
}

/**
 * Same as `unsupported()`, but for the branches where Hall has a specific,
 * diagnosed reason file-editing cannot be trusted right now — see
 * `RESTRICTED_FILE_EDIT_OBSERVATIONS`'s doc comment.
 */
function unsupportedRestricted(
  diagnosticMessage: string,
  detectedVersion?: string,
): AgentDetectionResult {
  const result: AgentDetectionResult = {
    installed: true,
    availability: "unsupported",
    diagnosticMessage,
    executionTrust: "unavailable",
    capabilityObservations: [...BASELINE_OBSERVATIONS, ...RESTRICTED_FILE_EDIT_OBSERVATIONS],
  };
  return detectedVersion !== undefined ? { ...result, detectedVersion } : result;
}

function available(diagnosticMessage: string, detectedVersion?: string): AgentDetectionResult {
  const result: AgentDetectionResult = {
    installed: true,
    availability: "available",
    diagnosticMessage,
    executionTrust: "trusted_local",
    capabilityObservations: [
      {
        capability: "project.read",
        status: "verified",
        safeSummary:
          "Verified through a real browser-driven Codex file-edit task in trusted-local mode.",
        evidence: "browser_smoke_test",
      },
      {
        capability: "project.edit",
        status: "verified",
        safeSummary:
          "Verified through a real browser-driven Codex file-edit task in trusted-local mode.",
        evidence: "browser_smoke_test",
      },
      ...BASELINE_OBSERVATIONS,
      {
        capability: "command.execute",
        status: "declared",
        safeSummary:
          "Trusted-local mode allows shell command execution; not independently verified live.",
        evidence: "declared_only",
      },
      {
        capability: "git.inspect",
        status: "declared",
        safeSummary: "The CLI can inspect a Git repository; not independently verified live.",
        evidence: "declared_only",
      },
      {
        capability: "session.resume",
        status: "unsupported",
        safeSummary: "This adapter never uses `codex exec resume`.",
        evidence: "declared_only",
      },
      {
        capability: "network.access",
        status: "unsupported",
        safeSummary: "Network access is never offered to a task through this adapter.",
        evidence: "declared_only",
      },
    ],
    limitations: [TRUSTED_LOCAL_AVAILABLE_MESSAGE],
  };
  return detectedVersion !== undefined ? { ...result, detectedVersion } : result;
}

/** True only for the two structurally-retryable outcomes — never a string match. */
function isRetryableProbeFailure(result: {
  readonly spawnError?: string | undefined;
  readonly timedOut: boolean;
}): boolean {
  return result.spawnError !== undefined || result.timedOut;
}

/**
 * Phase 10.3 — runs the `--version` probe, and if (and only if) that first
 * attempt has `process_start_failed` or `process_timeout`, waits
 * `retryDelayMs` and runs it exactly once more. A structurally-successful
 * first attempt (process actually started and exited, whatever its exit
 * code or output) is never retried — see the classification doc comment
 * above `DEFAULT_VERSION_RETRY_DELAY_MS`. The second attempt's result is
 * returned unconditionally, whether it succeeds or fails; there is no
 * third attempt.
 */
async function runVersionProbeWithBoundedRetry(
  spawner: ProcessSpawner,
  executablePath: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
  retryDelayMs: number,
) {
  const first = await runBoundedProcess({
    spawner,
    executablePath,
    args: ["--version"],
    cwd,
    env,
    timeoutMs,
  });
  if (!isRetryableProbeFailure(first)) return first;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, retryDelayMs);
  });
  return runBoundedProcess({ spawner, executablePath, args: ["--version"], cwd, env, timeoutMs });
}

function extractVersion(stdout: string): string | undefined {
  const firstLine = stdout.split("\n")[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) return undefined;
  return firstLine.length > MAX_DETECTED_VERSION_LENGTH
    ? firstLine.slice(0, MAX_DETECTED_VERSION_LENGTH)
    : firstLine;
}

/**
 * Detects whether a local, ChatGPT-authenticated Codex CLI is usable.
 * Never returns an executable path, account email, workspace/org name,
 * `CODEX_HOME`, or raw `codex login status` output — see
 * `docs/architecture/0009-codex-adapter.md`, "Authentication and billing
 * safety".
 *
 * Uses the exact same sanitized environment
 * (`buildChildEnvironment(options.parentEnv)`) for both this function's
 * own `codex login status` call and, separately, whatever task execution
 * later calls `detect()` first — a verified-ChatGPT detection result must
 * actually predict what auth source real task execution uses. See the
 * module doc comment on `environment.ts`.
 */
export async function detectCodex(options: DetectionOptions): Promise<AgentDetectionResult> {
  const pathValue = getEnvValueCaseInsensitive(options.parentEnv, "PATH") ?? "";
  const pathExt = getEnvValueCaseInsensitive(options.parentEnv, "PATHEXT");
  const resolution = resolveCodexExecutable({
    platform: options.platform,
    pathValue,
    fs: options.fs,
    ...(pathExt !== undefined ? { pathExt } : {}),
    ...(options.binaryName !== undefined ? { binaryName: options.binaryName } : {}),
  });

  if (!resolution.found || resolution.executable === undefined) {
    return unavailable("Codex CLI was not found on PATH.");
  }

  const executablePath = resolution.executable.path;
  const env = buildChildEnvironment(options.parentEnv);
  const cwd = tmpdir();

  const versionResult = await runVersionProbeWithBoundedRetry(
    options.spawner,
    executablePath,
    cwd,
    env,
    options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS,
    options.versionRetryDelayMs ?? DEFAULT_VERSION_RETRY_DELAY_MS,
  );

  if (isRetryableProbeFailure(versionResult)) {
    return unavailable("Codex CLI could not be started.");
  }
  if (versionResult.exitCode !== 0) {
    return unsupported("Codex CLI did not report a usable version.");
  }
  const detectedVersion = extractVersion(versionResult.stdout);

  // Fail closed before ever checking auth if this installation cannot be
  // confirmed to support the required isolated-execution flag profile —
  // see cli-compatibility.ts. No real model request is made either way.
  // Fetched exactly once per detectCodex call — Phase 10.1's "no repeated
  // spawns per request" detection-stability guarantee — and reused below
  // for the trusted-local marker check rather than spawning `exec --help`
  // a second time.
  const execHelpText = await fetchCodexExecHelpText({
    spawner: options.spawner,
    executablePath,
    cwd,
    env,
    detectedVersionString: detectedVersion,
    ...(options.helpTimeoutMs !== undefined ? { helpTimeoutMs: options.helpTimeoutMs } : {}),
  });
  if (execHelpText === undefined || !matchesIsolationFlags(execHelpText)) {
    return unsupported(UNSUPPORTED_ISOLATION_PROFILE_MESSAGE, detectedVersion);
  }

  const authResult = await runBoundedProcess({
    spawner: options.spawner,
    executablePath,
    args: ["login", "status"],
    cwd,
    env,
    timeoutMs: options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
  });

  if (authResult.spawnError !== undefined || authResult.timedOut) {
    return unsupported(UNVERIFIED_CHATGPT_MESSAGE, detectedVersion);
  }

  // Confirmed live during Phase 10 reconnaissance: `codex login status`
  // writes its human-readable status line to *stderr*, not stdout (e.g.
  // "Logged in using ChatGPT" arrives on stderr with an empty stdout).
  // Rather than depend on that specific, undocumented stream choice
  // staying stable across CLI versions (and in case some other status
  // wording ever uses stdout instead), both bounded streams are
  // concatenated before classification — parseLoginStatusOutput only
  // ever substring-matches a fixed set of known-safe patterns, so
  // widening its input to "either stream" carries no additional risk.
  // parseLoginStatusOutput reduces this combined text to a safe, bounded
  // classification and never returns the raw string — nothing below this
  // line ever touches authResult.stdout/authResult.stderr again.
  const classification = parseLoginStatusOutput(`${authResult.stdout}\n${authResult.stderr}`);

  if (classification.authenticationKind === "logged_out") {
    const result: AgentDetectionResult = {
      installed: true,
      availability: "logged_out",
      diagnosticMessage: "Codex is installed but not signed in.",
      executionTrust: "unavailable",
      capabilityObservations: BASELINE_OBSERVATIONS,
    };
    return detectedVersion !== undefined ? { ...result, detectedVersion } : result;
  }

  if (classification.authenticationKind === "api_key") {
    return unsupported(NOT_CHATGPT_MESSAGE, detectedVersion);
  }
  if (classification.authenticationKind === "access_token") {
    return unsupported(NOT_CHATGPT_MESSAGE, detectedVersion);
  }
  if (!classification.chatgptVerified) {
    // Covers "ambiguous" — an output this adapter could not confidently
    // interpret at all, distinct from a positively-identified non-ChatGPT
    // auth method above.
    return unsupported(UNVERIFIED_CHATGPT_MESSAGE, detectedVersion);
  }

  // Installation, isolation-flag support, and ChatGPT authentication are
  // all confirmed at this point. Phase 10.1's fail-closed default still
  // applies unconditionally: unless trusted-local mode was explicitly
  // enabled by the operator at Hall Core startup, this adapter never
  // reports "available" — see UNVERIFIED_EXECUTION_CAPABILITY_MESSAGE.
  if (options.trustedLocal?.enabled !== true) {
    return unsupportedRestricted(UNVERIFIED_EXECUTION_CAPABILITY_MESSAGE, detectedVersion);
  }

  // Phase 10.2 — trusted-local mode is explicitly enabled. Every check
  // below is still zero-model-usage and still fails closed to
  // "unsupported": a real file edit has never been claimed as verified in
  // strict mode, but trusted-local mode's own bypass flag (see
  // permission-profile.ts) removes the sandbox restriction that caused
  // every Phase 10 write attempt to fail, so this mode is allowed to
  // report "available" once every precondition below is confirmed —
  // never merely assumed from the flag being set.
  if (!options.trustedLocal.loopbackBound) {
    return unsupportedRestricted(TRUSTED_LOCAL_NOT_LOOPBACK_MESSAGE, detectedVersion);
  }
  if (options.trustedLocal.workspaceRoot.trim().length === 0) {
    return unsupportedRestricted(TRUSTED_LOCAL_WORKSPACE_NOT_CONFIGURED_MESSAGE, detectedVersion);
  }
  if (hasBlockedBillingEnvironmentKey(options.parentEnv)) {
    return unsupportedRestricted(TRUSTED_LOCAL_BILLING_ENV_BLOCKED_MESSAGE, detectedVersion);
  }

  // Reuses execHelpText fetched above — no second `exec --help` spawn.
  if (!matchesTrustedLocalFlags(execHelpText)) {
    return unsupportedRestricted(TRUSTED_LOCAL_FLAG_UNSUPPORTED_MESSAGE, detectedVersion);
  }

  return available(TRUSTED_LOCAL_AVAILABLE_MESSAGE, detectedVersion);
}
