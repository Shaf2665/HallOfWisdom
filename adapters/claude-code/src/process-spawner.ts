import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

type SpawnedChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface SpawnedProcessHandle {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(callback: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The only thing in this package allowed to call `node:child_process.spawn`
 * directly — every other module depends on this narrow interface instead,
 * which is what makes `ClaudeCodeRun`/`runBoundedProcess` testable against
 * a fake supervisor with no real process ever created in a deterministic
 * test. `shell` is never set to `true`; `args` is always a real argv array,
 * never a joined command string.
 */
export interface ProcessSpawner {
  spawn(
    executablePath: string,
    args: readonly string[],
    options: SpawnOptions,
  ): SpawnedProcessHandle;
}

class NodeSpawnedProcessHandle implements SpawnedProcessHandle {
  readonly #child: SpawnedChildProcess;

  constructor(child: SpawnedChildProcess) {
    this.#child = child;
  }

  get pid(): number | undefined {
    return this.#child.pid;
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

/**
 * The real, Node-backed `ProcessSpawner`. Deliberately the only place in
 * this package that touches `node:child_process`: `stdin` is closed
 * immediately (`"ignore"`) since the task prompt is always passed as an
 * argv element, never via stdin — there is nothing for Claude Code to
 * read from stdin, and leaving it open would let a bug or a future
 * misconfiguration cause it to block waiting for interactive input that
 * will never arrive. `windowsHide` suppresses a visible console window
 * on Windows. `shell` is always `false`.
 */
export const nodeProcessSpawner: ProcessSpawner = {
  spawn(executablePath, args, options) {
    const child = spawn(executablePath, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // On POSIX, makes the child the leader of its own new process
      // group (its PID becomes the PGID), which is what lets
      // `process-tree.ts` terminate the whole tree — including
      // grandchildren Claude Code itself spawns — via a single
      // negative-PID signal, rather than only the direct child.
      // `detached` means something unrelated on Windows (console
      // behavior, not process groups), so it is never set there.
      detached: process.platform !== "win32",
    });
    return new NodeSpawnedProcessHandle(child);
  },
};
