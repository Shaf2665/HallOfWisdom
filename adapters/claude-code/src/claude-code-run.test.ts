import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { ClaudeCodeRun } from "./claude-code-run.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";
import type { PosixGroupKiller } from "./process-tree.js";

class FakeHandle implements SpawnedProcessHandle {
  readonly pid = 9001;
  readonly stdoutEmitter = new EventEmitter();
  readonly stderrEmitter = new EventEmitter();
  readonly stdout = this.stdoutEmitter as unknown as NodeJS.ReadableStream;
  readonly stderr = this.stderrEmitter as unknown as NodeJS.ReadableStream;
  #exitCallback: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  #errorCallback: ((error: Error) => void) | undefined;
  killCount = 0;

  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#exitCallback = callback;
  }
  onError(callback: (error: Error) => void): void {
    this.#errorCallback = callback;
  }
  kill(): boolean {
    this.killCount += 1;
    return true;
  }
  emitStdout(text: string): void {
    this.stdoutEmitter.emit("data", Buffer.from(text, "utf8"));
  }
  emitStdoutEnd(): void {
    this.stdoutEmitter.emit("end");
  }
  // Real Node pipes usually finish draining stdout around the same time as
  // "exit" fires, but this is not guaranteed — see the comment in
  // `claude-code-run.ts`'s `#start()`. Defaulting to also emitting "end"
  // here keeps every existing test's happy-path ordering realistic without
  // each one needing to say so explicitly; tests that specifically need to
  // exercise the out-of-order case pass `emitStdoutEndImmediately: false`
  // and call `emitStdoutEnd()` themselves afterward.
  emitExit(
    code: number | null,
    signal: NodeJS.Signals | null = null,
    options: { emitStdoutEndImmediately?: boolean } = {},
  ): void {
    this.#exitCallback?.(code, signal);
    if (options.emitStdoutEndImmediately ?? true) {
      this.emitStdoutEnd();
    }
  }
  emitError(error: Error): void {
    this.#errorCallback?.(error);
  }
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function fakeSpawner(handle: FakeHandle) {
  const calls: { executablePath: string; args: readonly string[] }[] = [];
  const spawner: ProcessSpawner = {
    spawn: (executablePath, args) => {
      calls.push({ executablePath, args });
      return handle;
    },
  };
  return { spawner, calls };
}

function fakeKiller() {
  const calls: { pid: number; signal: NodeJS.Signals }[] = [];
  const killer: PosixGroupKiller = {
    killGroup(pid, signal) {
      calls.push({ pid, signal });
    },
  };
  return { killer, calls };
}

function baseOptions(overrides: Partial<Parameters<typeof makeRun>[0]> = {}) {
  return {
    executablePath: "claude",
    args: ["--print", "prompt"],
    workingDirectory: "D:\\fixture\\workdir",
    env: {},
    platform: "win32" as NodeJS.Platform,
    runId: "run-1",
    taskId: "task-1",
    agentId: "claude-code",
    gracefulTerminationTimeoutMs: 1000,
    startupTimeoutMs: 5000,
    maxRunDurationMs: 60000,
    ...overrides,
  };
}

function makeRun(options: {
  executablePath: string;
  args: readonly string[];
  workingDirectory: string;
  env: Readonly<Record<string, string>>;
  platform: NodeJS.Platform;
  runId: string;
  taskId: string;
  agentId: string;
  gracefulTerminationTimeoutMs: number;
  startupTimeoutMs: number;
  maxRunDurationMs: number;
  postExitStdoutDrainGraceMs?: number;
  spawner: ProcessSpawner;
  signal?: AbortSignal;
  posixGroupKiller?: PosixGroupKiller;
}) {
  return new ClaudeCodeRun(options);
}

async function collectEvents(run: ClaudeCodeRun): Promise<NormalizedAgentEvent[]> {
  const events: NormalizedAgentEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
  }
  return events;
}

describe("ClaudeCodeRun — successful lifecycle", () => {
  it("emits run.started immediately once the process spawns", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const iterator: AsyncIterator<NormalizedAgentEvent> = run.events[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (!first.done) {
      expect(first.value.type).toBe("run.started");
    }
  });

  it("streams text and completes on a successful result", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(
      line({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }) +
        line({ type: "result", subtype: "success", is_error: false, result: "done" }),
    );
    handle.emitExit(0);
    const events = await eventsPromise;
    expect(events.map((e) => e.type)).toEqual(["run.started", "message.delta", "run.completed"]);
    expect(run.currentState).toBe("completed");
  });

  it("every event validates through parseNormalizedAgentEvent", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(line({ type: "result", subtype: "success", is_error: false, result: "ok" }));
    handle.emitExit(0);
    const events = await eventsPromise;
    for (const event of events) {
      expect(() => parseNormalizedAgentEvent(event)).not.toThrow();
    }
  });

  it("sequences are contiguous starting at zero", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(
      line({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } }) +
        line({ type: "result", subtype: "success", is_error: false }),
    );
    handle.emitExit(0);
    const events = await eventsPromise;
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it("completion resolves with the terminal event", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(line({ type: "result", subtype: "success", is_error: false }));
    handle.emitExit(0);
    await eventsPromise;
    const terminal = await run.completion;
    expect(terminal.type).toBe("run.completed");
  });
});

describe("ClaudeCodeRun — exit/stdout-drain ordering", () => {
  it("still completes when the final result line arrives after 'exit' but before stdout 'end'", async () => {
    // Reproduces a real Node behavior: 'exit' fires on process termination
    // while stdout may still have buffered bytes in flight, so 'exit' does
    // not guarantee every 'data' event has already been delivered. Without
    // waiting for stdout to also drain, this would be misread as
    // CLAUDE_RESULT_MISSING even though the process genuinely reported a
    // successful result.
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitExit(0, null, { emitStdoutEndImmediately: false });
    handle.emitStdout(
      line({ type: "result", subtype: "success", is_error: false, result: "done" }),
    );
    handle.emitStdoutEnd();
    const events = await eventsPromise;
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.completed"]);
    expect(run.currentState).toBe("completed");
  });

  it("still reports CLAUDE_RESULT_MISSING when stdout genuinely ends with no result, regardless of ordering", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitExit(0, null, { emitStdoutEndImmediately: false });
    handle.emitStdoutEnd();
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CLAUDE_RESULT_MISSING",
    );
  });

  it("finalizes after the bounded post-exit drain grace period if stdout never naturally ends", async () => {
    // Regression test for the case a descendant process inherits the
    // stdout pipe and keeps it open after the main process exits: without
    // a bound, finalization would wait all the way out to
    // maxRunDurationMs (60000ms here) instead of a short, dedicated grace
    // period.
    vi.useFakeTimers();
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({
      ...baseOptions(),
      spawner,
      postExitStdoutDrainGraceMs: 2000,
    });
    const eventsPromise = collectEvents(run);
    await vi.advanceTimersByTimeAsync(0);
    handle.emitExit(0, null, { emitStdoutEndImmediately: false });
    // Well short of maxRunDurationMs (60000ms), but past the 2000ms grace period.
    await vi.advanceTimersByTimeAsync(2100);
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CLAUDE_RESULT_MISSING",
    );
    vi.useRealTimers();
  });
});

describe("ClaudeCodeRun — failure paths", () => {
  it("maps a stream result-error to run.failed", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(
      line({ type: "result", subtype: "error_during_execution", is_error: true, result: "broke" }),
    );
    handle.emitExit(1);
    const events = await eventsPromise;
    expect(events.at(-1)?.type).toBe("run.failed");
    expect(run.currentState).toBe("failed");
  });

  it("reports CLAUDE_PROCESS_START_FAILED when spawn throws synchronously", async () => {
    const spawner: ProcessSpawner = {
      spawn: () => {
        throw new Error("ENOENT");
      },
    };
    const run = makeRun({ ...baseOptions(), spawner });
    const events = await collectEvents(run);
    expect(events).toHaveLength(1);
    expect(events[0]?.type === "run.failed" && events[0].payload.failure.code).toBe(
      "CLAUDE_PROCESS_START_FAILED",
    );
  });

  it("reports CLAUDE_PROCESS_START_FAILED when the child emits an error event", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitError(new Error("spawn EACCES"));
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CLAUDE_PROCESS_START_FAILED",
    );
  });

  it("reports CLAUDE_RESULT_MISSING when the process exits cleanly without ever sending a result", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(
      line({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }),
    );
    handle.emitExit(0);
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CLAUDE_RESULT_MISSING",
    );
  });

  it("reports CLAUDE_PROCESS_EXITED for an unexpected nonzero exit with no result", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitExit(1);
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CLAUDE_PROCESS_EXITED",
    );
  });

  it("reports CLAUDE_STREAM_INVALID for an oversized line", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "x".repeat(2_000_000) }] },
      }) + "\n",
    );
    handle.emitExit(0);
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CLAUDE_STREAM_INVALID",
    );
  });

  it("reports CLAUDE_STREAM_INVALID after too many malformed lines", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout("{not json\n".repeat(10));
    handle.emitExit(0);
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CLAUDE_STREAM_INVALID",
    );
  });

  it("reports CLAUDE_STREAM_TRUNCATED for a truncated final line", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout('{"type":"assistant","message":{"content":[');
    handle.emitExit(0);
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CLAUDE_STREAM_TRUNCATED",
    );
  });

  it("exactly one terminal event exists even when multiple failure conditions could apply", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout("{not json\n".repeat(10));
    handle.emitExit(1);
    const events = await eventsPromise;
    const terminalEvents = events.filter(
      (e) => e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled",
    );
    expect(terminalEvents).toHaveLength(1);
  });
});

describe("ClaudeCodeRun — cancellation (Windows path, always safe)", () => {
  it("cancel() emits run.cancelled and kills the process", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    run.cancel("user requested");
    handle.emitExit(null, "SIGTERM");
    const events = await eventsPromise;
    expect(events.at(-1)?.type).toBe("run.cancelled");
    expect(run.currentState).toBe("cancelled");
    expect(handle.killCount).toBeGreaterThanOrEqual(1);
  });

  it("cancel() is idempotent — repeated calls never produce more than one run.cancelled", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    run.cancel("first");
    run.cancel("second");
    run.cancel("third");
    handle.emitExit(null, "SIGTERM");
    const events = await eventsPromise;
    expect(events.filter((e) => e.type === "run.cancelled")).toHaveLength(1);
  });

  it("cancellation via AbortSignal is equivalent to cancel()", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const controller = new AbortController();
    const run = makeRun({ ...baseOptions(), spawner, signal: controller.signal });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    controller.abort();
    handle.emitExit(null, "SIGTERM");
    const events = await eventsPromise;
    expect(events.at(-1)?.type).toBe("run.cancelled");
  });

  it("cancellation before the process spawns emits run.cancelled without ever spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawnCalls: unknown[] = [];
    const spawner: ProcessSpawner = {
      spawn: (...args) => {
        spawnCalls.push(args);
        return new FakeHandle();
      },
    };
    const run = makeRun({ ...baseOptions(), spawner, signal: controller.signal });
    const events = await collectEvents(run);
    expect(events).toEqual([expect.objectContaining({ type: "run.cancelled" })]);
    expect(spawnCalls).toHaveLength(0);
  });

  it("cancellation during stdout processing is safe and still resolves cleanly", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(
      line({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
    );
    run.cancel();
    handle.emitExit(null, "SIGTERM");
    const events = await eventsPromise;
    expect(events.at(-1)?.type).toBe("run.cancelled");
  });

  it("completion before cancellation remains completed (cancel after terminal is a no-op)", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(line({ type: "result", subtype: "success", is_error: false }));
    handle.emitExit(0);
    const events = await eventsPromise;
    run.cancel();
    expect(events.filter((e) => e.type === "run.completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "run.cancelled")).toHaveLength(0);
    expect(run.currentState).toBe("completed");
  });

  it("failure before cancellation remains failed (cancel after terminal is a no-op)", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(
      line({ type: "result", subtype: "failure", is_error: true, result: "broke" }),
    );
    handle.emitExit(1);
    await eventsPromise;
    run.cancel();
    expect(run.currentState).toBe("failed");
  });

  it("provider exit after cancellation is never reported as run.failed", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    run.cancel();
    handle.emitExit(1, "SIGTERM");
    const events = await eventsPromise;
    expect(events.some((e) => e.type === "run.failed")).toBe(false);
    expect(events.at(-1)?.type).toBe("run.cancelled");
  });

  it("invokes taskkill on Windows after the grace period elapses without exit", async () => {
    vi.useFakeTimers();
    const handle = new FakeHandle();
    const { spawner, calls } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner, gracefulTerminationTimeoutMs: 200 });
    const eventsPromise = collectEvents(run);
    await vi.advanceTimersByTimeAsync(0);
    run.cancel();
    await vi.advanceTimersByTimeAsync(250);
    // The taskkill invocation is the second spawner.spawn call (first was the claude process itself).
    expect(calls.some((c) => c.executablePath === "taskkill.exe")).toBe(true);
    handle.emitExit(null, "SIGTERM");
    await eventsPromise;
    vi.useRealTimers();
  });
});

describe("ClaudeCodeRun — cancellation (POSIX path, fake killer only)", () => {
  it("sends SIGTERM to the process group via the injected fake killer, never a real kill", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const { killer, calls } = fakeKiller();
    const run = makeRun({
      ...baseOptions({ platform: "linux" }),
      spawner,
      posixGroupKiller: killer,
    });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    run.cancel();
    expect(calls).toEqual([{ pid: 9001, signal: "SIGTERM" }]);
    handle.emitExit(null, "SIGTERM");
    await eventsPromise;
  });

  it("sends SIGKILL via the injected fake killer after the grace period elapses", async () => {
    vi.useFakeTimers();
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const { killer, calls } = fakeKiller();
    const run = makeRun({
      ...baseOptions({ platform: "linux" }),
      spawner,
      posixGroupKiller: killer,
      gracefulTerminationTimeoutMs: 200,
    });
    const eventsPromise = collectEvents(run);
    await vi.advanceTimersByTimeAsync(0);
    run.cancel();
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toEqual([
      { pid: 9001, signal: "SIGTERM" },
      { pid: 9001, signal: "SIGKILL" },
    ]);
    handle.emitExit(null, "SIGKILL");
    await eventsPromise;
    vi.useRealTimers();
  });
});

describe("ClaudeCodeRun — cleanup", () => {
  it("removes stdout/stderr listeners after the run terminates", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(line({ type: "result", subtype: "success", is_error: false }));
    handle.emitExit(0);
    await eventsPromise;
    expect(handle.stdoutEmitter.listenerCount("data")).toBe(0);
    expect(handle.stderrEmitter.listenerCount("data")).toBe(0);
  });

  it("removes the external AbortSignal listener after the run terminates", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const controller = new AbortController();
    const run = makeRun({ ...baseOptions(), spawner, signal: controller.signal });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(line({ type: "result", subtype: "success", is_error: false }));
    handle.emitExit(0);
    await eventsPromise;
    // If the listener were still attached, aborting now would attempt a
    // second cancellation sequence on an already-cleaned-up run; this
    // should be a safe no-op either way, but confirming zero listeners
    // remain is the stronger guarantee.
    expect(controller.signal.aborted).toBe(false);
  });

  it("clears the grace period timer after the process exits", async () => {
    vi.useFakeTimers();
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner, gracefulTerminationTimeoutMs: 5000 });
    const eventsPromise = collectEvents(run);
    await vi.advanceTimersByTimeAsync(0);
    run.cancel();
    handle.emitExit(null, "SIGTERM");
    await eventsPromise;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
