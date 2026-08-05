import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";
import {
  forceTerminateProcessTree,
  requestGracefulTermination,
  type PosixGroupKiller,
} from "./process-tree.js";

export interface BoundedProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted?: boolean | undefined;
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
  readonly signal?: AbortSignal | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly gracefulTerminationTimeoutMs?: number | undefined;
  readonly posixGroupKiller?: PosixGroupKiller | undefined;
}

const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_GRACEFUL_TERMINATION_TIMEOUT_MS = 500;

interface RemovableReadableStream {
  removeListener(event: "data", listener: (chunk: Buffer) => void): NodeJS.ReadableStream;
}

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
    let aborted = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let abortCleanup: (() => void) | undefined;
    let stdoutHandler: ((chunk: Buffer) => void) | undefined;
    let stderrHandler: ((chunk: Buffer) => void) | undefined;
    let terminationStarted = false;

    if (options.signal?.aborted === true) {
      resolve({ exitCode: null, signal: null, stdout, stderr, timedOut: false, aborted: true });
      return;
    }

    let handle: SpawnedProcessHandle;
    try {
      handle = options.spawner.spawn(options.executablePath, options.args, {
        cwd: options.cwd,
        env: options.env,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        timedOut: false,
        spawnError: error instanceof Error ? error.message : "spawn failed",
      });
      return;
    }

    handle.stdin.end();

    function cleanup(): void {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (forceTimer !== undefined) {
        clearTimeout(forceTimer);
        forceTimer = undefined;
      }
      if (settleTimer !== undefined) {
        clearTimeout(settleTimer);
        settleTimer = undefined;
      }
      abortCleanup?.();
      abortCleanup = undefined;
      if (stdoutHandler !== undefined) {
        removeDataListener(handle.stdout, stdoutHandler);
        stdoutHandler = undefined;
      }
      if (stderrHandler !== undefined) {
        removeDataListener(handle.stderr, stderrHandler);
        stderrHandler = undefined;
      }
    }

    function terminate(): void {
      if (terminationStarted) return;
      terminationStarted = true;
      handle.kill();
      if (settled) return;
      const pid = handle.pid;
      if (pid === undefined) {
        settleTimer = setTimeout(() => {
          settle({ exitCode: null, signal: null, stdout, stderr, timedOut, aborted });
        }, 0);
        return;
      }
      const platform = options.platform ?? process.platform;
      requestGracefulTermination({
        platform,
        pid,
        spawner: options.spawner,
        env: options.env,
        ...(options.posixGroupKiller !== undefined
          ? { posixGroupKiller: options.posixGroupKiller }
          : {}),
      });
      forceTimer = setTimeout(() => {
        forceTerminateProcessTree({
          platform,
          pid,
          spawner: options.spawner,
          env: options.env,
          ...(options.posixGroupKiller !== undefined
            ? { posixGroupKiller: options.posixGroupKiller }
            : {}),
        });
        settleTimer = setTimeout(() => {
          settle({ exitCode: null, signal: null, stdout, stderr, timedOut, aborted });
        }, 0);
      }, options.gracefulTerminationTimeoutMs ?? DEFAULT_GRACEFUL_TERMINATION_TIMEOUT_MS);
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    function settle(result: BoundedProcessResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    if (options.signal !== undefined) {
      const onAbort = () => {
        aborted = true;
        terminate();
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      abortCleanup = () => {
        options.signal?.removeEventListener("abort", onAbort);
      };
    }

    stdoutHandler = (chunk: Buffer) => {
      if (stdout.length < maxOutputChars) {
        stdout += chunk.toString("utf8");
        if (stdout.length > maxOutputChars) stdout = stdout.slice(0, maxOutputChars);
      }
    };
    handle.stdout.on("data", stdoutHandler);
    stderrHandler = (chunk: Buffer) => {
      if (stderr.length < maxOutputChars) {
        stderr += chunk.toString("utf8");
        if (stderr.length > maxOutputChars) stderr = stderr.slice(0, maxOutputChars);
      }
    };
    handle.stderr.on("data", stderrHandler);

    handle.onError((error) => {
      settle({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        ...(aborted ? { aborted } : {}),
        spawnError: error.message,
      });
    });

    handle.onExit((exitCode, signal) => {
      settle({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        ...(aborted ? { aborted } : {}),
      });
    });
  });
}

function removeDataListener(
  stream: NodeJS.ReadableStream,
  listener: (chunk: Buffer) => void,
): void {
  const candidate: unknown = stream;
  if (isRemovableReadableStream(candidate)) {
    candidate.removeListener("data", listener);
  }
}

function isRemovableReadableStream(value: unknown): value is RemovableReadableStream {
  return (
    typeof value === "object" &&
    value !== null &&
    "removeListener" in value &&
    typeof value.removeListener === "function"
  );
}
