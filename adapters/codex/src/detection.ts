import { tmpdir } from "node:os";
import type { AgentDetectionResult } from "@hall-of-wisdom/agent-adapter-sdk";
import { resolveCodexExecutable, type FileSystemProbe } from "./executable-resolver.js";
import { buildChildEnvironment } from "./environment.js";
import { runBoundedProcess } from "./bounded-process.js";
import type { ProcessSpawner } from "./process-spawner.js";
import { getEnvValueCaseInsensitive } from "./env-lookup.js";
import { parseLoginStatusOutput } from "./auth-classification.js";
import { verifyIsolationFlagSupport } from "./cli-compatibility.js";

export interface DetectionOptions {
  readonly platform: NodeJS.Platform;
  readonly parentEnv: Readonly<NodeJS.ProcessEnv>;
  readonly fs: FileSystemProbe;
  readonly spawner: ProcessSpawner;
  readonly binaryName?: string;
  readonly versionTimeoutMs?: number;
  readonly authTimeoutMs?: number;
  readonly helpTimeoutMs?: number;
}

const DEFAULT_VERSION_TIMEOUT_MS = 5000;
const DEFAULT_AUTH_TIMEOUT_MS = 5000;
const MAX_DETECTED_VERSION_LENGTH = 64;

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

function unavailable(diagnosticMessage: string): AgentDetectionResult {
  return { installed: false, availability: "unavailable", diagnosticMessage };
}

function unsupported(diagnosticMessage: string, detectedVersion?: string): AgentDetectionResult {
  const result: AgentDetectionResult = {
    installed: true,
    availability: "unsupported",
    diagnosticMessage,
  };
  return detectedVersion !== undefined ? { ...result, detectedVersion } : result;
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

  const versionResult = await runBoundedProcess({
    spawner: options.spawner,
    executablePath,
    args: ["--version"],
    cwd,
    env,
    timeoutMs: options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS,
  });

  if (versionResult.spawnError !== undefined || versionResult.timedOut) {
    return unavailable("Codex CLI could not be started.");
  }
  if (versionResult.exitCode !== 0) {
    return unsupported("Codex CLI did not report a usable version.");
  }
  const detectedVersion = extractVersion(versionResult.stdout);

  // Fail closed before ever checking auth if this installation cannot be
  // confirmed to support the required isolated-execution flag profile —
  // see cli-compatibility.ts. No real model request is made either way.
  const isolationFlagsSupported = await verifyIsolationFlagSupport({
    spawner: options.spawner,
    executablePath,
    cwd,
    env,
    detectedVersionString: detectedVersion,
    ...(options.helpTimeoutMs !== undefined ? { helpTimeoutMs: options.helpTimeoutMs } : {}),
  });
  if (!isolationFlagsSupported) {
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
  // all confirmed at this point — but see the module-level comment on
  // UNVERIFIED_EXECUTION_CAPABILITY_MESSAGE: this adapter still never
  // reports "available" until a real file edit has genuinely succeeded.
  return unsupported(UNVERIFIED_EXECUTION_CAPABILITY_MESSAGE, detectedVersion);
}
