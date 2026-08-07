import { spawn as nodeSpawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { AgentWorktreeGitOperationError, boundSafeSummary } from "./agent-worktree-errors.js";

type PipedChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface GitCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes?: Buffer | undefined;
  readonly stderrBytes?: Buffer | undefined;
  readonly stdoutTruncated?: boolean | undefined;
  readonly stderrTruncated?: boolean | undefined;
  readonly timedOut: boolean;
  readonly spawnError: string | undefined;
}

/**
 * A fixed, closed set of environment overrides a single Git invocation may request — never an
 * arbitrary `Record<string, string>`. This is deliberately not a general env-passthrough
 * mechanism: it exists only so `GIT_LFS_SKIP_SMUDGE` can be scoped to the one checkout invocation
 * that needs it (see `agent-worktree-manager.ts`'s `createWorktree`), and the type itself makes it
 * structurally impossible for a future caller to thread an arbitrary or task-controlled value
 * through this path.
 */
export interface GitCommandEnvOverrides {
  readonly GIT_LFS_SKIP_SMUDGE?: "1" | undefined;
}

export interface GitCommandRunnerInput {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly maxOutputChars?: number | undefined;
  /** Scoped to this one invocation only — never persisted, never logged, never widened. */
  readonly envOverrides?: GitCommandEnvOverrides | undefined;
}

export interface GitCommandRunner {
  run(input: GitCommandRunnerInput): Promise<GitCommandResult>;
}

export interface SpawnedGitProcessHandle {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(callback: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface GitProcessSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
}

export interface GitProcessSpawner {
  spawn(
    executablePath: string,
    args: readonly string[],
    options: GitProcessSpawnOptions,
  ): SpawnedGitProcessHandle;
}

export interface NodeGitCommandRunnerOptions {
  readonly gitExecutablePath?: string | undefined;
  readonly parentEnv?: Readonly<NodeJS.ProcessEnv> | undefined;
  readonly spawner?: GitProcessSpawner | undefined;
}

const DEFAULT_GIT_EXECUTABLE = "git";
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

export class NodeGitCommandRunner implements GitCommandRunner {
  readonly #gitExecutablePath: string;
  readonly #parentEnv: Readonly<NodeJS.ProcessEnv>;
  readonly #spawner: GitProcessSpawner;

  constructor(options: NodeGitCommandRunnerOptions = {}) {
    this.#gitExecutablePath = options.gitExecutablePath ?? DEFAULT_GIT_EXECUTABLE;
    this.#parentEnv = options.parentEnv ?? process.env;
    this.#spawner = options.spawner ?? nodeGitProcessSpawner;
    if (this.#gitExecutablePath.trim().length === 0) {
      throw new AgentWorktreeGitOperationError(
        "GIT_EXECUTABLE_INVALID",
        "Git executable is empty.",
      );
    }
  }

  run(input: GitCommandRunnerInput): Promise<GitCommandResult> {
    if (input.args.length === 0 || input.args.some((arg) => arg.length === 0)) {
      throw new AgentWorktreeGitOperationError(
        "GIT_ARGUMENTS_INVALID",
        "Git command arguments must not be empty.",
      );
    }
    if (input.timeoutMs <= 0) {
      throw new AgentWorktreeGitOperationError(
        "GIT_TIMEOUT_INVALID",
        "Git command timeout must be positive.",
      );
    }
    const baseEnv = buildAgentWorktreeGitEnvironment(this.#parentEnv);
    const env =
      input.envOverrides === undefined
        ? baseEnv
        : { ...baseEnv, ...stripUndefined(input.envOverrides) };
    return runBoundedGitProcess({
      spawner: this.#spawner,
      executablePath: this.#gitExecutablePath,
      args: input.args,
      cwd: input.cwd,
      env,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      maxOutputChars: input.maxOutputChars,
    });
  }
}

export function assertGitSuccess(result: GitCommandResult, safeFailureCode: string): string {
  if (result.exitCode === 0 && !result.timedOut && result.spawnError === undefined) {
    return result.stdout;
  }
  if (result.timedOut) {
    throw new AgentWorktreeGitOperationError(safeFailureCode, "Git command timed out.");
  }
  if (result.spawnError !== undefined) {
    throw new AgentWorktreeGitOperationError(safeFailureCode, "Git command could not be started.");
  }
  throw new AgentWorktreeGitOperationError(safeFailureCode, boundSafeSummary(result.stderr));
}

export function buildAgentWorktreeGitEnvironment(
  parentEnv: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const allowedKeys = [
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
  ] as const;
  const byLowerName = new Map<string, string>();
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined) byLowerName.set(key.toLowerCase(), value);
  }
  const env: Record<string, string> = {};
  for (const key of allowedKeys) {
    const value = byLowerName.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
  };
}

function stripUndefined(overrides: GitCommandEnvOverrides): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  if (overrides.GIT_LFS_SKIP_SMUDGE !== undefined) {
    result.GIT_LFS_SKIP_SMUDGE = overrides.GIT_LFS_SKIP_SMUDGE;
  }
  return result;
}

interface RunBoundedGitProcessOptions {
  readonly spawner: GitProcessSpawner;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly maxOutputChars: number | undefined;
}

function runBoundedGitProcess(options: RunBoundedGitProcessOptions): Promise<GitCommandResult> {
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        stdoutBytes: Buffer.alloc(0),
        stderrBytes: Buffer.alloc(0),
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        spawnError: "aborted",
      });
      return;
    }
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    const handle = options.spawner.spawn(options.executablePath, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
    });
    handle.stdin.end();

    const settle = (result: GitCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      handle.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      handle.kill();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }

    handle.stdout.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stdout, chunk);
      stdout = appended.next;
      stdoutTruncated ||= appended.hitLimit;
    });
    handle.stderr.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stderr, chunk);
      stderr = appended.next;
      stderrTruncated ||= appended.hitLimit;
    });
    handle.onError((error) => {
      settle({
        exitCode: null,
        signal: null,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutBytes: stdout,
        stderrBytes: stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        spawnError: error.message,
      });
    });
    handle.onExit((exitCode, signal) => {
      settle({
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutBytes: stdout,
        stderrBytes: stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        spawnError: undefined,
      });
    });
  });

  function appendBounded(
    current: Buffer,
    chunk: Buffer,
  ): { readonly next: Buffer; readonly hitLimit: boolean } {
    if (current.length >= maxOutputChars) return { next: current, hitLimit: true };
    const remaining = maxOutputChars - current.length;
    if (chunk.length > remaining) {
      return { next: Buffer.concat([current, chunk.subarray(0, remaining)]), hitLimit: true };
    }
    return { next: Buffer.concat([current, chunk]), hitLimit: false };
  }
}

class NodeSpawnedGitProcessHandle implements SpawnedGitProcessHandle {
  readonly #child: PipedChildProcess;

  constructor(child: PipedChildProcess) {
    this.#child = child;
  }

  get stdin(): NodeJS.WritableStream {
    return this.#child.stdin;
  }

  get stdout(): NodeJS.ReadableStream {
    return this.#child.stdout;
  }

  get stderr(): NodeJS.ReadableStream {
    return this.#child.stderr;
  }

  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#child.on("exit", callback);
  }

  onError(callback: (error: Error) => void): void {
    this.#child.on("error", callback);
  }

  kill(signal?: NodeJS.Signals): boolean {
    return this.#child.kill(signal);
  }
}

export const nodeGitProcessSpawner: GitProcessSpawner = {
  spawn(executablePath, args, options) {
    const child = nodeSpawn(executablePath, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: options.shell,
      windowsHide: true,
    }) as PipedChildProcess;
    return new NodeSpawnedGitProcessHandle(child);
  },
};
