import type { ProcessSpawner } from "./process-spawner.js";
import { runBoundedProcess } from "./bounded-process.js";

interface SemverPrefix {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Earliest Codex CLI version this adapter's required isolated-execution
 * flag set has actually been confirmed against the real installed CLI
 * (`codex-cli 0.144.4`, during Phase 10). This is a cheap first-pass
 * filter only — the authoritative check is the bounded `codex exec --help`
 * scan below, since a version number alone does not guarantee a flag
 * still exists or means the same thing.
 */
export const MIN_SUPPORTED_CODEX_VERSION: SemverPrefix = { major: 0, minor: 144, patch: 4 };

/**
 * Literal substrings this adapter's fixed argv (see
 * `permission-profile.ts`) depends on, confirmed present in `codex exec
 * --help` for the installed 0.144.4 CLI during Phase 10 reconnaissance.
 * `--ask-for-approval` is deliberately NOT in this list: `codex exec
 * --help`'s own option list does not include it at all (it only exists on
 * the root/interactive `codex` command) — passing it to `codex exec`
 * fails with `error: unexpected argument '--ask-for-approval' found`,
 * confirmed live during reconnaissance. See
 * `docs/architecture/0009-codex-adapter.md`, "Why --ask-for-approval is
 * never passed to codex exec".
 */
const REQUIRED_HELP_MARKERS = [
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--sandbox",
  "--cd",
  "-c, --config",
] as const;

const DEFAULT_HELP_TIMEOUT_MS = 5000;

/**
 * Codex's own `--version` output is `codex-cli <major>.<minor>.<patch>`
 * (confirmed live: `codex-cli 0.144.4`) — a package/binary label prefix,
 * not a bare semver string like the Claude CLI's. This strips any
 * non-digit prefix before matching the version numbers themselves.
 */
export function parseSemverPrefix(versionString: string): SemverPrefix | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionString.trim());
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
 * — only once that passes — a bounded `codex exec --help` inspection that
 * confirms every required flag name is still literally present. The full
 * help text is read into bounded process memory only for this check and
 * is never returned, logged, or exposed anywhere outside this function —
 * only the resulting boolean crosses this boundary. See
 * `docs/architecture/0009-codex-adapter.md`, "Required CLI compatibility
 * flags" and "Fail-closed behaviour for old versions".
 */
export async function verifyIsolationFlagSupport(
  options: IsolationFlagSupportOptions,
): Promise<boolean> {
  const parsedVersion =
    options.detectedVersionString !== undefined
      ? parseSemverPrefix(options.detectedVersionString)
      : undefined;
  if (parsedVersion === undefined || !isAtLeast(parsedVersion, MIN_SUPPORTED_CODEX_VERSION)) {
    return false;
  }

  const helpResult = await runBoundedProcess({
    spawner: options.spawner,
    executablePath: options.executablePath,
    args: ["exec", "--help"],
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
