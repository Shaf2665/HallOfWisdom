import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoundedProcess } from "./bounded-process.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";
import type { PosixGroupKiller } from "./process-tree.js";

class FakeBoundedHandle implements SpawnedProcessHandle {
  readonly stdoutEmitter = new EventEmitter();
  readonly stderrEmitter = new EventEmitter();
  readonly stdin = { end: () => undefined, write: () => true } as unknown as NodeJS.WritableStream;
  readonly stdout = this.stdoutEmitter as unknown as NodeJS.ReadableStream;
  readonly stderr = this.stderrEmitter as unknown as NodeJS.ReadableStream;
  killCount = 0;
  #exitCallback: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  #errorCallback: ((error: Error) => void) | undefined;

  constructor(
    private readonly exitOnKill = false,
    readonly pid: number | undefined = 4321,
  ) {}

  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#exitCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.#errorCallback = callback;
  }

  kill(): boolean {
    this.killCount += 1;
    if (this.exitOnKill) this.#exitCallback?.(null, "SIGTERM");
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.#exitCallback?.(code, signal);
  }

  emitError(error: Error): void {
    this.#errorCallback?.(error);
  }
}

describe("runBoundedProcess", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("terminates the full POSIX process group on timeout and settles without an exit callback", async () => {
    const handle = new FakeBoundedHandle(false);
    const signals: NodeJS.Signals[] = [];
    const killer: PosixGroupKiller = {
      killGroup(_pid, signal) {
        signals.push(signal);
      },
    };
    const spawner: ProcessSpawner = {
      spawn: () => handle,
    };
    const resultPromise = runBoundedProcess({
      spawner,
      executablePath: "codex",
      args: ["--version"],
      cwd: "D:\\fixture",
      env: {},
      timeoutMs: 1,
      gracefulTerminationTimeoutMs: 1,
      platform: "linux",
      posixGroupKiller: killer,
    });
    await expect(resultPromise).resolves.toMatchObject({ timedOut: true, exitCode: null });
    expect(handle.killCount).toBe(1);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("normal exits are unaffected and do not force a process-tree kill", async () => {
    vi.useFakeTimers();
    const handle = new FakeBoundedHandle(false);
    const signals: NodeJS.Signals[] = [];
    const spawner: ProcessSpawner = {
      spawn: () => handle,
    };
    const resultPromise = runBoundedProcess({
      spawner,
      executablePath: "codex",
      args: ["login", "status"],
      cwd: "D:\\fixture",
      env: {},
      timeoutMs: 1000,
      gracefulTerminationTimeoutMs: 50,
      platform: "linux",
      posixGroupKiller: {
        killGroup(_pid, signal) {
          signals.push(signal);
        },
      },
    });
    handle.emitExit(0);
    const result = await resultPromise;
    expect(result).toMatchObject({ timedOut: false, exitCode: 0 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(handle.killCount).toBe(0);
    expect(signals).toEqual([]);
  });

  it("aborts a running bounded process and returns a bounded cancellation result", async () => {
    const handle = new FakeBoundedHandle(false);
    const controller = new AbortController();
    const spawner: ProcessSpawner = {
      spawn: () => handle,
    };
    const resultPromise = runBoundedProcess({
      spawner,
      executablePath: "codex",
      args: ["exec", "--help"],
      cwd: "D:\\fixture",
      env: {},
      timeoutMs: 1000,
      gracefulTerminationTimeoutMs: 1,
      platform: "linux",
      posixGroupKiller: { killGroup: () => undefined },
      signal: controller.signal,
    });
    controller.abort("secret reason");
    const result = await resultPromise;
    expect(result).toMatchObject({ aborted: true, timedOut: false });
    expect(JSON.stringify(result)).not.toContain("secret reason");
  });

  it("settles after timeout even when the process has no pid and never exits", async () => {
    const handle = new FakeBoundedHandle(false, undefined);
    const spawner: ProcessSpawner = {
      spawn: () => handle,
    };
    const result = await runBoundedProcess({
      spawner,
      executablePath: "codex",
      args: ["--version"],
      cwd: "D:\\fixture",
      env: {},
      timeoutMs: 1,
      gracefulTerminationTimeoutMs: 1,
      platform: "linux",
      posixGroupKiller: { killGroup: () => undefined },
    });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(handle.killCount).toBe(1);
  });
});
