import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseNormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { CodexRun } from "./codex-run.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";
import type { PosixGroupKiller } from "./process-tree.js";

class FakeHandle implements SpawnedProcessHandle {
  readonly pid = 9001;
  readonly stdoutEmitter = new EventEmitter();
  readonly stderrEmitter = new EventEmitter();
  readonly stdinEmitter = new EventEmitter();
  readonly stdout = this.stdoutEmitter as unknown as NodeJS.ReadableStream;
  readonly stderr = this.stderrEmitter as unknown as NodeJS.ReadableStream;
  readonly stdinWrites: string[] = [];
  stdinEnded = false;
  readonly stdin = {
    write: (data: string, _enc: string, cb?: () => void) => {
      this.stdinWrites.push(data);
      cb?.();
      return true;
    },
    end: () => {
      this.stdinEnded = true;
    },
    on: (event: string, cb: (...args: unknown[]) => void) => this.stdinEmitter.on(event, cb),
    removeListener: (event: string, cb: (...args: unknown[]) => void) =>
      this.stdinEmitter.removeListener(event, cb),
  } as unknown as NodeJS.WritableStream;

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

const AGENT_MESSAGE = (text: string) =>
  line({ type: "item.completed", item: { id: `item_${text}`, type: "agent_message", text } });
const TURN_COMPLETED = line({ type: "turn.completed", usage: {} });
const TURN_FAILED = (message: string) => line({ type: "turn.failed", message });

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
    executablePath: "codex",
    args: ["exec", "--json", "-"],
    prompt: "do the task",
    workingDirectory: "D:\\fixture\\workdir",
    env: {},
    platform: "win32" as NodeJS.Platform,
    runId: "run-1",
    taskId: "task-1",
    agentId: "codex",
    gracefulTerminationTimeoutMs: 1000,
    startupTimeoutMs: 5000,
    maxRunDurationMs: 60000,
    ...overrides,
  };
}

function makeRun(options: {
  executablePath: string;
  args: readonly string[];
  prompt: string;
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
  return new CodexRun(options);
}

async function collectEvents(run: CodexRun): Promise<NormalizedAgentEvent[]> {
  const events: NormalizedAgentEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
  }
  return events;
}

describe("CodexRun — successful lifecycle", () => {
  it("emits run.started immediately once the process spawns", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const iterator: AsyncIterator<NormalizedAgentEvent> = run.events[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (!first.done) expect(first.value.type).toBe("run.started");
  });

  it("writes the prompt to stdin and closes it", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    expect(handle.stdinWrites.join("")).toBe("do the task");
    expect(handle.stdinEnded).toBe(true);
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    await eventsPromise;
  });

  it("streams text and completes on turn.completed", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(AGENT_MESSAGE("hello") + TURN_COMPLETED);
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
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    const events = await eventsPromise;
    for (const event of events) expect(() => parseNormalizedAgentEvent(event)).not.toThrow();
  });

  it("sequences are contiguous starting at zero", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(AGENT_MESSAGE("a") + TURN_COMPLETED);
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
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    await eventsPromise;
    const terminal = await run.completion;
    expect(terminal.type).toBe("run.completed");
  });

  it("a valid stdout turn.started is accepted without disturbing the already-emitted run.started", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(line({ type: "turn.started" }) + TURN_COMPLETED);
    handle.emitExit(0);
    const events = await eventsPromise;
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.completed"]);
  });

  it("exit/stdout-drain ordering: still completes when the final result line arrives after 'exit' but before stdout 'end'", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitExit(0, null, { emitStdoutEndImmediately: false });
    handle.emitStdout(TURN_COMPLETED);
    handle.emitStdoutEnd();
    const events = await eventsPromise;
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.completed"]);
  });
});

describe("CodexRun — event-channel isolation (Phase 10.1)", () => {
  function line(obj: unknown): string {
    return JSON.stringify(obj) + "\n";
  }

  it("a well-formed stderr turn.started emits nothing", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.stderrEmitter.emit("data", Buffer.from(line({ type: "turn.started" }), "utf8"));
    await Promise.resolve();
    expect(run.currentState).toBe("running");
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    const events = await eventsPromise;
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.completed"]);
  });

  it("a well-formed stderr turn.completed cannot complete the run", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.stderrEmitter.emit("data", Buffer.from(TURN_COMPLETED, "utf8"));
    await Promise.resolve();
    expect(run.currentState).toBe("running");
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    const events = await eventsPromise;
    expect(events.filter((e) => e.type === "run.completed")).toHaveLength(1);
  });

  it("a well-formed stderr item.completed agent_message cannot emit message.delta", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.stderrEmitter.emit("data", Buffer.from(AGENT_MESSAGE("from stderr"), "utf8"));
    await Promise.resolve();
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    const events = await eventsPromise;
    expect(events.some((e) => e.type === "message.delta")).toBe(false);
  });

  it("a well-formed stderr command_execution cannot emit a tool event", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.stderrEmitter.emit(
      "data",
      Buffer.from(
        line({
          type: "item.started",
          item: { id: "item_1", type: "command_execution", status: "in_progress" },
        }) +
          line({
            type: "item.completed",
            item: { id: "item_1", type: "command_execution", exit_code: 0, status: "completed" },
          }),
        "utf8",
      ),
    );
    await Promise.resolve();
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    const events = await eventsPromise;
    expect(events.some((e) => e.type === "tool.started" || e.type === "tool.completed")).toBe(
      false,
    );
  });

  it("a well-formed stderr file_change cannot emit file.changed", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.stderrEmitter.emit(
      "data",
      Buffer.from(
        line({
          type: "item.completed",
          item: {
            id: "item_5",
            type: "file_change",
            status: "completed",
            changes: [{ path: "NOTES.md", kind: "modify" }],
          },
        }),
        "utf8",
      ),
    );
    await Promise.resolve();
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    const events = await eventsPromise;
    expect(events.some((e) => e.type === "file.changed")).toBe(false);
  });

  it("malformed stderr does not corrupt valid stdout processing", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.stderrEmitter.emit("data", Buffer.from("{not valid json at all\n".repeat(50), "utf8"));
    handle.emitStdout(AGENT_MESSAGE("hi") + TURN_COMPLETED);
    handle.emitExit(0);
    const events = await eventsPromise;
    expect(events.map((e) => e.type)).toEqual(["run.started", "message.delta", "run.completed"]);
  });

  it("oversized stderr is bounded safely and does not affect stdout processing", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.stderrEmitter.emit("data", Buffer.from("x".repeat(5_000_000), "utf8"));
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    const events = await eventsPromise;
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("sensitive-looking stderr content never reaches any Hall event", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    const sentinel = "FAKE_SECRET_TOKEN_should_never_leak_9f8e7d";
    handle.stderrEmitter.emit(
      "data",
      Buffer.from(`ERROR something failed: ${sentinel}\n${AGENT_MESSAGE("hi")}`, "utf8"),
    );
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    const events = await eventsPromise;
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });

  it("cancellation remains first-terminal-wins even if stderr carries a well-formed terminal-shaped event", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    run.cancel();
    handle.stderrEmitter.emit("data", Buffer.from(TURN_COMPLETED, "utf8"));
    handle.emitExit(null, "SIGTERM");
    const events = await eventsPromise;
    expect(events.at(-1)?.type).toBe("run.cancelled");
    expect(events.some((e) => e.type === "run.completed")).toBe(false);
  });
});

describe("CodexRun — failure paths", () => {
  it("maps turn.failed to run.failed", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(TURN_FAILED("broke"));
    handle.emitExit(1);
    const events = await eventsPromise;
    expect(events.at(-1)?.type).toBe("run.failed");
    expect(run.currentState).toBe("failed");
  });

  it("reports CODEX_PROCESS_START_FAILED when spawn throws synchronously", async () => {
    const spawner: ProcessSpawner = {
      spawn: () => {
        throw new Error("ENOENT");
      },
    };
    const run = makeRun({ ...baseOptions(), spawner });
    const events = await collectEvents(run);
    expect(events).toHaveLength(1);
    expect(events[0]?.type === "run.failed" && events[0].payload.failure.code).toBe(
      "CODEX_PROCESS_START_FAILED",
    );
  });

  it("reports CODEX_PROCESS_START_FAILED when the child emits an error event", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitError(new Error("spawn EACCES"));
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CODEX_PROCESS_START_FAILED",
    );
  });

  it("reports CODEX_PROCESS_START_FAILED when stdin write fails", async () => {
    const handle = new FakeHandle();
    handle.stdin.write = () => {
      throw new Error("EPIPE");
    };
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const events = await collectEvents(run);
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CODEX_PROCESS_START_FAILED",
    );
  });

  it("reports CODEX_RESULT_MISSING when the process exits cleanly without ever sending a terminal event", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(AGENT_MESSAGE("partial"));
    handle.emitExit(0);
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CODEX_RESULT_MISSING",
    );
  });

  it("reports CODEX_PROCESS_EXITED for an unexpected nonzero exit with no result", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitExit(1);
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CODEX_PROCESS_EXITED",
    );
  });

  it("reports CODEX_STREAM_INVALID for an oversized line on stdout", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(
      JSON.stringify({
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "x".repeat(2_000_000) },
      }) + "\n",
    );
    handle.emitExit(0);
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CODEX_STREAM_INVALID",
    );
  });

  it("reports CODEX_STREAM_TRUNCATED for a truncated final line on stdout", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout('{"type":"item.completed","item":{');
    handle.emitExit(0);
    const events = await eventsPromise;
    const failure = events.find((e) => e.type === "run.failed");
    expect(failure?.type === "run.failed" && failure.payload.failure.code).toBe(
      "CODEX_STREAM_TRUNCATED",
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

describe("CodexRun — cancellation (Windows path, always safe)", () => {
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

  it("cancellation during stdin write / stdout processing is safe and still resolves cleanly", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(AGENT_MESSAGE("working"));
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
    handle.emitStdout(TURN_COMPLETED);
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
    handle.emitStdout(TURN_FAILED("broke"));
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
    expect(calls.some((c) => c.executablePath === "taskkill.exe")).toBe(true);
    handle.emitExit(null, "SIGTERM");
    await eventsPromise;
    vi.useRealTimers();
  });
});

describe("CodexRun — cancellation (POSIX path, fake killer only)", () => {
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

describe("CodexRun — cleanup", () => {
  it("removes stdout/stderr/stdin listeners after the run terminates", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const run = makeRun({ ...baseOptions(), spawner });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    await eventsPromise;
    expect(handle.stdoutEmitter.listenerCount("data")).toBe(0);
    expect(handle.stderrEmitter.listenerCount("data")).toBe(0);
    expect(handle.stdinEmitter.listenerCount("error")).toBe(0);
  });

  it("removes the external AbortSignal listener after the run terminates", async () => {
    const handle = new FakeHandle();
    const { spawner } = fakeSpawner(handle);
    const controller = new AbortController();
    const run = makeRun({ ...baseOptions(), spawner, signal: controller.signal });
    const eventsPromise = collectEvents(run);
    await Promise.resolve();
    handle.emitStdout(TURN_COMPLETED);
    handle.emitExit(0);
    await eventsPromise;
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
