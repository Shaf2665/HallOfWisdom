import type { ProcessSpawner } from "./process-spawner.js";

export interface BoundedProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError?: string | undefined;
}

export interface RunBoundedProcessOptions {
  readonly spawner: ProcessSpawner;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputChars?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

/**
 * Runs one short-lived process to completion (or until it's killed for
 * exceeding `timeoutMs`), capturing bounded stdout/stderr. Used by
 * `detection.ts` for `--version`, `login status`, and the bounded
 * `--help` compatibility scan — all expected to complete quickly and
 * produce a small, bounded amount of output, and none of them need to
 * write anything to stdin. Immediately closes stdin (nothing for these
 * short-lived commands to read from it) so none of them can ever block
 * waiting for input that will never arrive. The long-running, streaming
 * task execution in `codex-run.ts` uses `ProcessSpawner` directly instead,
 * since it needs to write a prompt to stdin and process stdout
 * incrementally rather than wait for the whole thing.
 */
export function runBoundedProcess(
  options: RunBoundedProcessOptions,
): Promise<BoundedProcessResult> {
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const handle = options.spawner.spawn(options.executablePath, options.args, {
      cwd: options.cwd,
      env: options.env,
    });

    handle.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      handle.kill();
    }, options.timeoutMs);

    function settle(result: BoundedProcessResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    handle.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxOutputChars) {
        stdout += chunk.toString("utf8");
        if (stdout.length > maxOutputChars) stdout = stdout.slice(0, maxOutputChars);
      }
    });
    handle.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < maxOutputChars) {
        stderr += chunk.toString("utf8");
        if (stderr.length > maxOutputChars) stderr = stderr.slice(0, maxOutputChars);
      }
    });

    handle.onError((error) => {
      settle({ exitCode: null, signal: null, stdout, stderr, timedOut, spawnError: error.message });
    });

    handle.onExit((exitCode, signal) => {
      settle({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}
