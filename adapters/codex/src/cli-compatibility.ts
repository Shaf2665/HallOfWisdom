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
  "--disable",
  "--cd",
  "-c, --config",
] as const;

/**
 * Phase 10.2 — literal substrings `buildCodexTrustedLocalArgv`
 * (`permission-profile.ts`) depends on. `--sandbox` is deliberately
 * excluded here: the trusted-local profile never passes it (see that
 * file's doc comment for why), so this list does not require the CLI to
 * still support a flag the trusted-local argv itself never uses.
 * `--dangerously-bypass-approvals-and-sandbox` was confirmed present,
 * exact name, on the installed CLI's own `codex exec --help` during Phase
 * 10.2 reconnaissance (`codex-cli 0.144.4`), and the full trusted-local
 * flag combination was separately confirmed to parse together via a
 * zero-usage `--strict-config` config-parse-failure probe — see
 * `permission-profile.ts`.
 */
const TRUSTED_LOCAL_REQUIRED_HELP_MARKERS = [
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--dangerously-bypass-approvals-and-sandbox",
  "--disable",
  "--cd",
] as const;

/**
 * Confirmed present, exact name, on `codex exec --help` for the installed
 * CLI ("`-i, --image <FILE>...` — Optional image(s) to attach to the
 * initial prompt"), via a live, zero-model-usage probe. Checked
 * independently of `REQUIRED_HELP_MARKERS`/`TRUSTED_LOCAL_REQUIRED_HELP_MARKERS`
 * so an older installed CLI that lacks only this flag still passes the
 * isolation profile it already supports — it just never reports
 * `vision.image` as `verified` (see `detectCodex`'s `available()` branch).
 */
const VISION_REQUIRED_HELP_MARKERS = ["--image"] as const;

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
  readonly signal?: AbortSignal | undefined;
}

/**
 * Fetches `codex exec --help`'s stdout, without ever running a real model
 * request. Two layers: a cheap version-floor check (fails closed
 * immediately on an unparseable or too-old version, with no further
 * process spawned), then — only once that passes — one bounded spawn.
 * Returns `undefined` for any failure (unsupported version, spawn error,
 * timeout, nonzero exit) so callers fail closed uniformly. The full help
 * text is read into bounded process memory only for this call and is
 * never returned beyond this module's own marker-matching, logged, or
 * exposed anywhere else. See `docs/architecture/0009-codex-adapter.md`,
 * "Required CLI compatibility flags" and "Fail-closed behaviour for old
 * versions".
 *
 * Phase 10.2: exported (not just module-private) so `detectCodex` can
 * fetch this exactly once per detection call and match both the strict
 * and trusted-local marker sets against the same result — Phase 10.1's
 * "no repeated spawns per request" detection-stability guarantee applies
 * to trusted-local mode too, not just to the strict-only flag profile.
 */
export async function fetchCodexExecHelpText(
  options: IsolationFlagSupportOptions,
): Promise<string | undefined> {
  const parsedVersion =
    options.detectedVersionString !== undefined
      ? parseSemverPrefix(options.detectedVersionString)
      : undefined;
  if (parsedVersion === undefined || !isAtLeast(parsedVersion, MIN_SUPPORTED_CODEX_VERSION)) {
    return undefined;
  }

  const helpResult = await runBoundedProcess({
    spawner: options.spawner,
    executablePath: options.executablePath,
    args: ["exec", "--help"],
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.helpTimeoutMs ?? DEFAULT_HELP_TIMEOUT_MS,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  if (helpResult.spawnError !== undefined || helpResult.timedOut || helpResult.exitCode !== 0) {
    return undefined;
  }

  return helpResult.stdout;
}

/** Pure marker match against already-fetched help text — never spawns. */
export function matchesIsolationFlags(helpText: string): boolean {
  return REQUIRED_HELP_MARKERS.every((marker) => helpText.includes(marker));
}

/** Pure marker match against already-fetched help text — never spawns. */
export function matchesTrustedLocalFlags(helpText: string): boolean {
  return TRUSTED_LOCAL_REQUIRED_HELP_MARKERS.every((marker) => helpText.includes(marker));
}

/** Pure marker match against already-fetched help text — never spawns. */
export function matchesVisionFlags(helpText: string): boolean {
  return VISION_REQUIRED_HELP_MARKERS.every((marker) => helpText.includes(marker));
}

export async function verifyIsolationFlagSupport(
  options: IsolationFlagSupportOptions,
): Promise<boolean> {
  const helpText = await fetchCodexExecHelpText(options);
  return helpText !== undefined && matchesIsolationFlags(helpText);
}

/**
 * Phase 10.2 — the trusted-local counterpart of `verifyIsolationFlagSupport`.
 * Called only when trusted-local mode is explicitly enabled and every
 * earlier strict-profile check has already passed; never runs a model
 * request, same bounded `codex exec --help` inspection technique.
 */
export async function verifyTrustedLocalFlagSupport(
  options: IsolationFlagSupportOptions,
): Promise<boolean> {
  const helpText = await fetchCodexExecHelpText(options);
  return helpText !== undefined && matchesTrustedLocalFlags(helpText);
}
