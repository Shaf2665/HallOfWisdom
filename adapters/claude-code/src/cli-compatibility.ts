import type { ProcessSpawner } from "./process-spawner.js";
import { runBoundedProcess } from "./bounded-process.js";

interface SemverPrefix {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Earliest Claude Code version this adapter's required isolated-execution
 * flag set (`--safe-mode`, `--no-chrome`, `--no-session-persistence`,
 * `--strict-mcp-config`, `--permission-mode`, `--allowedTools`,
 * `--disallowedTools`, `--tools`, `--output-format stream-json`) has
 * actually been confirmed against the real installed CLI (2.1.212, during
 * Phase 9). This is a cheap first-pass filter only — the authoritative
 * check is the bounded `--help` scan below, since a version number alone
 * does not guarantee a flag still exists or means the same thing.
 */
export const MIN_SUPPORTED_CLAUDE_VERSION: SemverPrefix = { major: 2, minor: 1, patch: 212 };

const REQUIRED_HELP_MARKERS = [
  "--safe-mode",
  "--no-chrome",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--permission-mode",
  "--allowedTools",
  "--disallowedTools",
  "--tools",
  "--output-format",
  "stream-json",
] as const;

const DEFAULT_HELP_TIMEOUT_MS = 5000;

export function parseSemverPrefix(versionString: string): SemverPrefix | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(versionString.trim());
  if (match === null) return undefined;
  const [, majorText, minorText, patchText] = match;
  return { major: Number(majorText), minor: Number(minorText), patch: Number(patchText) };
}

function isAtLeast(version: SemverPrefix, min: SemverPrefix): boolean {
  if (version.major !== min.major) return version.major > min.major;
  if (version.minor !== min.minor) return version.minor > min.minor;
  return version.patch >= min.patch;
}

export interface IsolationFlagSupportOptions {
  readonly spawner: ProcessSpawner;
  readonly executablePath: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detectedVersionString: string | undefined;
  readonly helpTimeoutMs?: number;
}

/**
 * Verifies the installed CLI can support this adapter's required isolated
 * execution profile, without ever running a real model request. Two
 * layers: a cheap version-floor check (fails closed immediately on an
 * unparseable or too-old version, with no further process spawned), then
 * — only once that passes — a bounded `claude --help` inspection that
 * confirms every required flag name (and the `stream-json` output-format
 * choice) is still literally present in the CLI's own help text. The full
 * help text is read into bounded process memory only for this check and
 * is never returned, logged, or exposed anywhere outside this function —
 * only the resulting boolean crosses this boundary. See
 * `docs/architecture/0008-claude-code-adapter.md`, "Required CLI
 * compatibility flags" and "Fail-closed behaviour for old versions".
 */
export async function verifyIsolationFlagSupport(
  options: IsolationFlagSupportOptions,
): Promise<boolean> {
  const parsedVersion =
    options.detectedVersionString !== undefined
      ? parseSemverPrefix(options.detectedVersionString)
      : undefined;
  if (parsedVersion === undefined || !isAtLeast(parsedVersion, MIN_SUPPORTED_CLAUDE_VERSION)) {
    return false;
  }

  const helpResult = await runBoundedProcess({
    spawner: options.spawner,
    executablePath: options.executablePath,
    args: ["--help"],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.helpTimeoutMs ?? DEFAULT_HELP_TIMEOUT_MS,
  });

  if (helpResult.spawnError !== undefined || helpResult.timedOut || helpResult.exitCode !== 0) {
    return false;
  }

  const helpText = helpResult.stdout;
  return REQUIRED_HELP_MARKERS.every((marker) => helpText.includes(marker));
}
