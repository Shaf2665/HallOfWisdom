import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runBoundedProcess } from "./bounded-process.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";

class FakeHandle implements SpawnedProcessHandle {
  readonly pid = 4242;
  readonly stdoutEmitter = new EventEmitter();
  readonly stderrEmitter = new EventEmitter();
  readonly stdout = this.stdoutEmitter as unknown as NodeJS.ReadableStream;
  readonly stderr = this.stderrEmitter as unknown as NodeJS.ReadableStream;
  #exitCallback: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  #errorCallback: ((error: Error) => void) | undefined;
  killed = false;

  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#exitCallback = callback;
  }
  onError(callback: (error: Error) => void): void {
    this.#errorCallback = callback;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitStdout(text: string): void {
    this.stdoutEmitter.emit("data", Buffer.from(text, "utf8"));
  }
  emitStderr(text: string): void {
    this.stderrEmitter.emit("data", Buffer.from(text, "utf8"));
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.#exitCallback?.(code, signal);
  }
  emitError(error: Error): void {
    this.#errorCallback?.(error);
  }
}

function fakeSpawner(handle: FakeHandle): ProcessSpawner {
  return { spawn: () => handle };
}

describe("runBoundedProcess", () => {
  it("resolves with stdout, stderr, and exit code on a clean exit", async () => {
    const handle = new FakeHandle();
    const promise = runBoundedProcess({
      spawner: fakeSpawner(handle),
      executablePath: "claude",
      args: ["--version"],
      cwd: "D:\\fixture",
      env: {},
      timeoutMs: 1000,
    });
    handle.emitStdout("2.1.212 (Claude Code)\n");
    handle.emitExit(0);
    const result = await promise;
    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stdout: "2.1.212 (Claude Code)\n",
      stderr: "",
      timedOut: false,
    });
  });

  it("accumulates stdout delivered across multiple chunks", async () => {
    const handle = new FakeHandle();
    const promise = runBoundedProcess({
      spawner: fakeSpawner(handle),
      executablePath: "claude",
      args: [],
      cwd: "D:\\fixture",
      env: {},
      timeoutMs: 1000,
    });
    handle.emitStdout('{"loggedIn":');
    handle.emitStdout("true}");
    handle.emitExit(0);
    const result = await promise;
    expect(result.stdout).toBe('{"loggedIn":true}');
  });

  it("captures stderr separately from stdout", async () => {
    const handle = new FakeHandle();
    const promise = runBoundedProcess({
      spawner: fakeSpawner(handle),
      executablePath: "claude",
      args: [],
      cwd: "D:\\fixture",
      env: {},
      timeoutMs: 1000,
    });
    handle.emitStderr("a warning\n");
    handle.emitExit(1);
    const result = await promise;
    expect(result.stderr).toBe("a warning\n");
    expect(result.exitCode).toBe(1);
  });

  it("bounds captured stdout to maxOutputChars", async () => {
    const handle = new FakeHandle();
    const promise = runBoundedProcess({
      spawner: fakeSpawner(handle),
      executablePath: "claude",
      args: [],
      cwd: "D:\\fixture",
      env: {},
      timeoutMs: 1000,
      maxOutputChars: 10,
    });
    handle.emitStdout("x".repeat(1000));
    handle.emitExit(0);
    const result = await promise;
    expect(result.stdout.length).toBeLessThanOrEqual(10);
  });

  it("kills the process and reports timedOut when the timeout elapses before exit", async () => {
    vi.useFakeTimers();
    const handle = new FakeHandle();
    const promise = runBoundedProcess({
      spawner: fakeSpawner(handle),
      executablePath: "claude",
      args: [],
      cwd: "D:\\fixture",
      env: {},
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(handle.killed).toBe(true);
    handle.emitExit(null, "SIGTERM");
    const result = await promise;
    expect(result.timedOut).toBe(true);
    vi.useRealTimers();
  });

  it("reports a spawn error safely rather than hanging forever", async () => {
    const handle = new FakeHandle();
    const promise = runBoundedProcess({
      spawner: fakeSpawner(handle),
      executablePath: "does-not-exist",
      args: [],
      cwd: "D:\\fixture",
      env: {},
      timeoutMs: 1000,
    });
    handle.emitError(new Error("ENOENT"));
    const result = await promise;
    expect(result.exitCode).toBeNull();
    expect(result.spawnError).toBe("ENOENT");
  });

  it("never resolves twice even if both exit and a late error fire", async () => {
    const handle = new FakeHandle();
    const promise = runBoundedProcess({
      spawner: fakeSpawner(handle),
      executablePath: "claude",
      args: [],
      cwd: "D:\\fixture",
      env: {},
      timeoutMs: 1000,
    });
    handle.emitExit(0);
    handle.emitError(new Error("late error, should be ignored"));
    const result = await promise;
    expect(result.exitCode).toBe(0);
  });
});
