import crossSpawn from "cross-spawn";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * `crossSpawn`'s own type declaration is a loose alias for
 * `typeof child_process.spawn` that does not preserve the stdio-tuple
 * overload TypeScript uses to know `stdin`/`stdout`/`stderr` are
 * guaranteed non-null. This adapter always calls it with a fixed
 * `stdio: ["pipe", "pipe", "pipe"]`, so that guarantee genuinely holds at
 * runtime; a single explicit cast at the one call site documents that
 * fact instead of scattering non-null (`!`) assertions across every
 * getter below (this codebase's lint rules forbid `!` assertions).
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
 * The only thing in this package allowed to launch a Codex child process —
 * every other module depends on this narrow interface instead, which is
 * what makes the run/detection logic testable against a fake supervisor
 * with no real process ever created in a deterministic test. `args` is
 * always a real argv array, never a joined command string.
 *
 * Task content never enters this interface's `args`: the Codex prompt is
 * always delivered by writing to `stdin` after spawn (see
 * `codex-run.ts`), never as an argv element — `args` is always the fixed,
 * Hall-controlled profile from `permission-profile.ts` plus the constant
 * trailing `"-"` sentinel.
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
 * The real, `cross-spawn`-backed `ProcessSpawner` — the one narrowly
 * scoped, reviewed spawn-compatibility mechanism this adapter uses
 * (per the Phase 10 spec's explicit allowance) to safely execute a
 * Windows `codex.cmd`/`codex.bat` npm shim when no directly-resolvable
 * native `codex.exe` is on `PATH` (see `executable-resolver.ts`).
 * `cross-spawn` is a transparent, widely-used (it is what `npm` itself
 * uses internally) drop-in replacement for `node:child_process.spawn`:
 * for a real native executable, or on any POSIX platform, it delegates
 * straight through to Node's own `spawn` with no behavioral change; only
 * for a Windows `.cmd`/`.bat` target does it apply its own
 * correctly-escaped `cmd.exe` invocation — never `shell: true`, and never
 * a manually concatenated command string built by this codebase. Every
 * argv element passed to it is either a fixed, Hall-controlled constant
 * or (for the prompt) delivered separately via `stdin`, never through
 * `args` — see the `ProcessSpawner` interface doc comment above and
 * `docs/architecture/0009-codex-adapter.md`, "Windows shim policy".
 *
 * `stdin` is piped (not ignored, unlike the Claude Code adapter): the
 * Codex task prompt is delivered by writing to it after spawn and then
 * closing it, specifically so prompt content never has to touch any
 * process argument list or command line — see `codex-run.ts`.
 * `windowsHide` suppresses a visible console window on Windows.
 */
export const nodeProcessSpawner: ProcessSpawner = {
  spawn(executablePath, args, options) {
    const child = crossSpawn(executablePath, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // On POSIX, makes the child the leader of its own new process
      // group (its PID becomes the PGID), which is what lets
      // `process-tree.ts` terminate the whole tree — including
      // grandchildren Codex itself spawns — via a single negative-PID
      // signal, rather than only the direct child. `detached` means
      // something unrelated on Windows (console behavior, not process
      // groups), so it is never set there.
      detached: process.platform !== "win32",
    }) as PipedChildProcess;
    return new NodeSpawnedProcessHandle(child);
  },
};
