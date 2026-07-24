import { spawn as nodeSpawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * `child_process.spawn`'s stdio-tuple overload guarantees non-null
 * `stdin`/`stdout`/`stderr` only when TypeScript can see the literal
 * `stdio: ["pipe", "pipe", "pipe"]` at the call site. This adapter always
 * calls it that way, so the guarantee genuinely holds at runtime; a
 * single cast at that one call site documents the fact instead of
 * scattering non-null (`!`) assertions elsewhere (forbidden by this
 * codebase's lint rules).
 */
type PipedChildProcess = ChildProcessByStdio<Writable, Readable, Readable>;

export interface SpawnedProcessHandle {
  readonly pid: number | undefined;
  readonly stdin: NodeJS.WritableStream;
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
 * The only thing in the comparisons module allowed to launch a `git`
 * child process — every other module in this directory depends on this
 * narrow interface instead, which is what makes `GitWorktreeManager`
 * testable against a fake spawner with no real process ever created in a
 * deterministic unit test. `args` is always a real argv array, never a
 * joined command string, and `shell` is never set — see
 * `AGENTS.md`, "Validate all paths ... avoid shell interpolation."
 */
export interface ProcessSpawner {
  spawn(
    executablePath: string,
    args: readonly string[],
    options: SpawnOptions,
  ): SpawnedProcessHandle;
}

class NodeSpawnedProcessHandle implements SpawnedProcessHandle {
  readonly #child: PipedChildProcess;

  constructor(child: PipedChildProcess) {
    this.#child = child;
  }

  get pid(): number | undefined {
    return this.#child.pid;
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

/**
 * The real, `node:child_process`-backed `ProcessSpawner`. Unlike the
 * Codex/Claude Code adapters, this never needs `cross-spawn`'s
 * `.cmd`/`.bat` shim handling: `git` on every supported platform (Git for
 * Windows, Homebrew, apt, etc.) ships as a genuine native executable, not
 * an npm-installed script shim, so Node's own `spawn` with `shell: false`
 * resolves and runs it correctly on Windows, macOS, and Linux alike —
 * adding `cross-spawn` as a dependency of this package would be
 * unnecessary (see `AGENTS.md`, "Dependencies").
 */
export const nodeProcessSpawner: ProcessSpawner = {
  spawn(executablePath, args, options) {
    const child = nodeSpawn(executablePath, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    }) as PipedChildProcess;
    return new NodeSpawnedProcessHandle(child);
  },
};
