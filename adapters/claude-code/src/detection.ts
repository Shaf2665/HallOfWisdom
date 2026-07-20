import { tmpdir } from "node:os";
import type { AgentDetectionResult } from "@hall-of-wisdom/agent-adapter-sdk";
import { resolveClaudeExecutable, type FileSystemProbe } from "./executable-resolver.js";
import { buildChildEnvironment } from "./environment.js";
import { runBoundedProcess } from "./bounded-process.js";
import type { ProcessSpawner } from "./process-spawner.js";
import { getEnvValueCaseInsensitive } from "./env-lookup.js";
import { parseAuthStatusOutput } from "./auth-classification.js";
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

const UNVERIFIED_SUBSCRIPTION_MESSAGE =
  "Claude Code authentication could not be verified as subscription-based.";

const UNSUPPORTED_ISOLATION_PROFILE_MESSAGE =
  "Installed Claude Code does not support the required isolated execution profile.";

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
 * Detects whether a local, subscription-authenticated Claude Code CLI is
 * usable. Never returns `executablePath`, an account email, an
 * organization identifier, or raw `claude auth status` output — see
 * `docs/architecture/0008-claude-code-adapter.md`, "Authentication and
 * billing safety".
 *
 * Uses the exact same sanitized environment
 * (`buildChildEnvironment(options.parentEnv)`) for both this function's
 * own `claude auth status` call and, separately, whatever task execution
 * later calls `detect()` first — this is deliberate: if detection and
 * execution used different environments, a verified-subscription
 * detection result would not actually predict what auth source the real
 * task execution ends up using. See the module doc comment on
 * `environment.ts`.
 */
export async function detectClaudeCode(options: DetectionOptions): Promise<AgentDetectionResult> {
  const pathValue = getEnvValueCaseInsensitive(options.parentEnv, "PATH") ?? "";
  const pathExt = getEnvValueCaseInsensitive(options.parentEnv, "PATHEXT");
  const resolutionOptions: Parameters<typeof resolveClaudeExecutable>[0] = {
    platform: options.platform,
    pathValue,
    fs: options.fs,
    ...(pathExt !== undefined ? { pathExt } : {}),
    ...(options.binaryName !== undefined ? { binaryName: options.binaryName } : {}),
  };
  const resolution = resolveClaudeExecutable(resolutionOptions);

  if (!resolution.found || resolution.executable === undefined) {
    return unavailable("Claude Code CLI was not found on PATH.");
  }

  if (resolution.executable.kind === "shim") {
    return unsupported(
      "Only an npm-installed Claude Code shim was found; install the native Claude Code binary to use this adapter.",
    );
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
    return unavailable("Claude Code CLI could not be started.");
  }
  if (versionResult.exitCode !== 0) {
    return unsupported("Claude Code CLI did not report a usable version.");
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
    args: ["auth", "status"],
    cwd,
    env,
    timeoutMs: options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
  });

  if (authResult.spawnError !== undefined || authResult.timedOut) {
    return unsupported(UNVERIFIED_SUBSCRIPTION_MESSAGE, detectedVersion);
  }

  // parseAuthStatusOutput reduces authResult.stdout to a safe, bounded
  // classification and never returns the raw string or parsed JSON —
  // nothing below this line ever touches authResult.stdout again.
  const classification = parseAuthStatusOutput(authResult.stdout);
  if (classification === undefined) {
    // Distinct from a successfully-parsed loggedIn:false result: the
    // output could not be safely interpreted at all (malformed, oversized,
    // or schema mismatch), not "cleanly logged out".
    return unsupported(UNVERIFIED_SUBSCRIPTION_MESSAGE, detectedVersion);
  }

  if (!classification.loggedIn) {
    const result: AgentDetectionResult = {
      installed: true,
      availability: "logged_out",
      diagnosticMessage: "Claude Code is installed but not logged in.",
    };
    return detectedVersion !== undefined ? { ...result, detectedVersion } : result;
  }

  if (!classification.subscriptionVerified) {
    return unsupported(UNVERIFIED_SUBSCRIPTION_MESSAGE, detectedVersion);
  }

  const result: AgentDetectionResult = {
    installed: true,
    availability: "available",
    diagnosticMessage: "Claude Code is installed and authenticated with a Claude subscription.",
  };
  return detectedVersion !== undefined ? { ...result, detectedVersion } : result;
}
