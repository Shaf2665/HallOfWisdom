import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHermesNodeSpawnOptions } from "./execution-process.js";
import type {
  HermesProcessSpawner,
  HermesProcessSpawnOptions,
  SpawnedHermesProcess,
} from "./execution-process.js";
import {
  HermesTransportError,
  HERMES_PROTOCOL_VERSION,
  MAX_HERMES_EVENT_BYTES,
  type HermesRawEvent,
  type HermesTransportErrorCode,
} from "./hermes-protocol.js";
import {
  startHermesExecutionTransport,
  type HermesExecutionRun,
  type HermesExecutionTransportOptions,
} from "./execution-transport.js";

const RUN_ID = "hall-run-123";

class FakeProcess implements SpawnedHermesProcess {
  readonly pid = 4242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #processEvents = new EventEmitter();
  readonly #stdinChunks: Buffer[] = [];
  terminateCount = 0;
  forceTerminateCount = 0;

  constructor() {
    this.stdin.on("data", (chunk: Buffer) => this.#stdinChunks.push(Buffer.from(chunk)));
  }

  get stdinText(): string {
    return Buffer.concat(this.#stdinChunks).toString("utf8");
  }

  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#processEvents.on("exit", callback);
  }

  onError(callback: (error: Error) => void): void {
    this.#processEvents.on("error", callback);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  forceTerminate(): void {
    this.forceTerminateCount += 1;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.#processEvents.emit("exit", code, signal);
  }

  emitError(): void {
    this.#processEvents.emit("error", new Error("raw spawn detail"));
  }
}

interface SpawnCall {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly options: HermesProcessSpawnOptions;
}

function recordingSpawner(child: FakeProcess): {
  readonly spawner: HermesProcessSpawner;
  readonly calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawner: {
      spawn(executablePath, args, options) {
        calls.push({ executablePath, args, options });
        return child;
      },
    },
  };
}

function options(
  child: FakeProcess,
  overrides: Partial<HermesExecutionTransportOptions> = {},
): HermesExecutionTransportOptions {
  const { spawner } = recordingSpawner(child);
  return {
    pythonExecutable: "/opt/python/bin/python3",
    runnerPath: "/opt/Hermes Router/hermes_agent_runner.py",
    workingDirectory: "/worktrees/task with spaces",
    env: { PATH: "/usr/bin", HERMES_ROUTER_API_KEY: "must-not-escape" },
    prompt: "Implement the task.",
    runId: RUN_ID,
    platform: "linux",
    spawner,
    ...overrides,
  };
}

function rawEvent(
  sequence: number,
  type: string,
  payload: unknown = {},
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    protocol: HERMES_PROTOCOL_VERSION,
    runtime_version: "0.1.0",
    run_id: RUN_ID,
    sequence,
    type,
    payload,
    ...overrides,
  };
}

function jsonl(...events: readonly Record<string, unknown>[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

async function collect(events: AsyncIterable<HermesRawEvent>): Promise<HermesRawEvent[]> {
  const collected: HermesRawEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function expectFailure(
  run: HermesExecutionRun,
  child: FakeProcess | undefined,
  code: HermesTransportErrorCode,
): Promise<HermesTransportError> {
  await nextTurn();
  child?.emitExit(null, "SIGTERM");
  const error = await run.completion.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HermesTransportError);
  expect(error).toMatchObject({ code });
  return error as HermesTransportError;
}

describe("Hermes execution process launch", () => {
  it("uses exact structured argv/cwd and writes one prompt/run-id JSON object before closing stdin", () => {
    const child = new FakeProcess();
    const { spawner, calls } = recordingSpawner(child);
    const env = { PATH: "/usr/bin", HERMES_ROUTER_API_KEY: "secret" };

    startHermesExecutionTransport(
      options(child, {
        spawner,
        env,
        prompt: "Use structured input.",
      }),
    );

    expect(calls).toEqual([
      {
        executablePath: "/opt/python/bin/python3",
        args: ["/opt/Hermes Router/hermes_agent_runner.py", "run"],
        options: {
          cwd: "/worktrees/task with spaces",
          env,
          platform: "linux",
        },
      },
    ]);
    expect(child.stdinText).toBe('{"prompt":"Use structured input.","run_id":"hall-run-123"}');
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("keeps paths containing spaces as single argv/cwd values", () => {
    const child = new FakeProcess();
    const { spawner, calls } = recordingSpawner(child);
    startHermesExecutionTransport(
      options(child, {
        spawner,
        pythonExecutable: "/Applications/Python 3/python3",
        runnerPath: "/Agent Runtimes/Hermes Router/hermes_agent_runner.py",
        workingDirectory: "/Hall Worktrees/task one",
      }),
    );

    expect(calls[0]?.executablePath).toBe("/Applications/Python 3/python3");
    expect(calls[0]?.args).toEqual(["/Agent Runtimes/Hermes Router/hermes_agent_runner.py", "run"]);
    expect(calls[0]?.options.cwd).toBe("/Hall Worktrees/task one");
  });

  it("accepts Windows-style absolute runner/worktree paths without shell quoting", () => {
    const child = new FakeProcess();
    const { spawner, calls } = recordingSpawner(child);
    startHermesExecutionTransport(
      options(child, {
        spawner,
        platform: "win32",
        pythonExecutable: "C:\\Python 3.13\\python.exe",
        runnerPath: "C:\\Agent Runtimes\\Hermes Router\\hermes_agent_runner.py",
        workingDirectory: "C:\\Hall Worktrees\\task one",
      }),
    );

    expect(calls[0]).toMatchObject({
      executablePath: "C:\\Python 3.13\\python.exe",
      args: ["C:\\Agent Runtimes\\Hermes Router\\hermes_agent_runner.py", "run"],
      options: { cwd: "C:\\Hall Worktrees\\task one", platform: "win32" },
    });
  });

  it("builds a piped, hidden, shell-free Node spawn with the environment unchanged", () => {
    const env = { PATH: "C:\\Windows\\System32", CUSTOM: "value" };
    const built = buildHermesNodeSpawnOptions({
      cwd: "C:\\Hall Worktrees\\task one",
      env,
      platform: "win32",
    });

    expect(built).toMatchObject({
      cwd: "C:\\Hall Worktrees\\task one",
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(built.env).toBe(env);
  });

  it("rejects oversized UTF-8 input before spawning", async () => {
    const child = new FakeProcess();
    const { spawner, calls } = recordingSpawner(child);
    const run = startHermesExecutionTransport(
      options(child, {
        spawner,
        prompt: "🚀".repeat(20),
        maxInputBytes: 32,
      }),
    );

    await expect(run.completion).rejects.toMatchObject({
      code: "HERMES_TRANSPORT_INVALID_INPUT",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("Hermes raw JSONL streaming", () => {
  it("streams a valid multi-line lifecycle and resolves with its single terminal event", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    const eventsPromise = collect(run.events);
    child.stdout.write(
      jsonl(
        rawEvent(0, "run.started"),
        rawEvent(1, "message.delta", { text: "Working" }),
        rawEvent(2, "tool.started", { tool_call_id: "call-1", tool_name: "project_read" }),
        rawEvent(3, "tool.completed", {
          tool_call_id: "call-1",
          tool_name: "project_read",
          success: true,
        }),
        rawEvent(4, "file.changed", { path: "app.ts", operation: "modified" }),
        rawEvent(5, "run.completed", { summary: "Done" }),
      ),
    );
    child.stdout.end();
    child.emitExit(0);

    const events = await eventsPromise;
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "tool.started",
      "tool.completed",
      "file.changed",
      "run.completed",
    ]);
    await expect(run.completion).resolves.toMatchObject({
      exitCode: 0,
      signal: null,
      terminalEvent: { type: "run.completed", sequence: 5 },
    });
    expect(run.currentState).toBe("exited");
  });

  it("parses fragmented stdout chunks across JSON and Unicode byte boundaries", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    const eventsPromise = collect(run.events);
    const output = Buffer.from(
      jsonl(
        rawEvent(0, "run.started"),
        rawEvent(1, "message.delta", { text: "Wisdom 🚀 नमस्ते" }),
        rawEvent(2, "run.completed", { summary: "完了" }),
      ),
      "utf8",
    );
    const rocket = output.indexOf(Buffer.from("🚀", "utf8"));
    for (const chunk of [
      output.subarray(0, 7),
      output.subarray(7, rocket + 1),
      output.subarray(rocket + 1, rocket + 3),
      output.subarray(rocket + 3),
    ]) {
      child.stdout.write(chunk);
    }
    child.stdout.end();
    child.emitExit(0);

    const events = await eventsPromise;
    expect(events[1]?.payload).toEqual({ text: "Wisdom 🚀 नमस्ते" });
    expect(events[2]?.payload).toEqual({ summary: "完了" });
    await expect(run.completion).resolves.toBeDefined();
  });

  it("accepts run.failed with the runtime's documented non-zero exit", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    child.stdout.end(
      jsonl(
        rawEvent(0, "run.started"),
        rawEvent(1, "run.failed", { code: "SAFE_FAILURE", message: "Safe failure." }),
      ),
    );
    child.emitExit(1);

    await expect(run.completion).resolves.toMatchObject({
      exitCode: 1,
      terminalEvent: { type: "run.failed" },
    });
  });
});

describe("Hermes protocol rejection", () => {
  it.each([
    {
      name: "wrong protocol",
      output: jsonl(rawEvent(0, "run.started", {}, { protocol: "hermes-agent/v2" })),
      code: "HERMES_TRANSPORT_INVALID_EVENT" as const,
    },
    {
      name: "wrong run id",
      output: jsonl(rawEvent(0, "run.started", {}, { run_id: "another-run" })),
      code: "HERMES_TRANSPORT_INVALID_EVENT" as const,
    },
    {
      name: "bad initial sequence",
      output: jsonl(rawEvent(1, "run.started")),
      code: "HERMES_TRANSPORT_INVALID_EVENT" as const,
    },
    {
      name: "non-monotonic sequence",
      output: jsonl(rawEvent(0, "run.started"), rawEvent(2, "run.completed")),
      code: "HERMES_TRANSPORT_INVALID_EVENT" as const,
    },
    {
      name: "unknown event type",
      output: jsonl(rawEvent(0, "run.started"), rawEvent(1, "run.paused")),
      code: "HERMES_TRANSPORT_INVALID_EVENT" as const,
    },
    {
      name: "invalid runtime version",
      output: jsonl(rawEvent(0, "run.started", {}, { runtime_version: "latest" })),
      code: "HERMES_TRANSPORT_INVALID_EVENT" as const,
    },
    {
      name: "non-object payload",
      output: jsonl(rawEvent(0, "run.started", [])),
      code: "HERMES_TRANSPORT_INVALID_EVENT" as const,
    },
    {
      name: "first event is not run.started",
      output: jsonl(rawEvent(0, "message.delta", { text: "too early" })),
      code: "HERMES_TRANSPORT_INVALID_EVENT" as const,
    },
    {
      name: "blank record",
      output: "\n",
      code: "HERMES_TRANSPORT_INVALID_EVENT" as const,
    },
    {
      name: "malformed JSON",
      output: "{not-json}\n",
      code: "HERMES_TRANSPORT_MALFORMED_JSON" as const,
    },
  ])("rejects $name", async ({ output, code }) => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    child.stdout.write(output);
    await expectFailure(run, child, code);
  });

  it("rejects malformed UTF-8", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    child.stdout.write(Buffer.from([0xff, 0x0a]));
    await expectFailure(run, child, "HERMES_TRANSPORT_INVALID_UTF8");
  });

  it("rejects an event over Hermes' 24,000-byte line limit", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    child.stdout.write(
      jsonl(rawEvent(0, "run.started", { text: "x".repeat(MAX_HERMES_EVENT_BYTES) })),
    );
    await expectFailure(run, child, "HERMES_TRANSPORT_LINE_TOO_LARGE");
  });

  it("rejects total stdout beyond the configured bound", async () => {
    const child = new FakeProcess();
    const started = jsonl(rawEvent(0, "run.started"));
    const run = startHermesExecutionTransport(
      options(child, { maxTotalOutputBytes: Buffer.byteLength(started) + 5 }),
    );
    child.stdout.write(started);
    child.stdout.write("123456");
    await expectFailure(run, child, "HERMES_TRANSPORT_OUTPUT_LIMIT");
  });

  it("rejects more than the configured event count", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child, { maxEventCount: 1 }));
    child.stdout.write(jsonl(rawEvent(0, "run.started"), rawEvent(1, "run.completed")));
    await expectFailure(run, child, "HERMES_TRANSPORT_EVENT_LIMIT");
  });

  it("rejects duplicate terminal events", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    child.stdout.write(
      jsonl(rawEvent(0, "run.started"), rawEvent(1, "run.completed"), rawEvent(2, "run.failed")),
    );
    await expectFailure(run, child, "HERMES_TRANSPORT_DUPLICATE_TERMINAL");
  });

  it("rejects a stream that ends without a terminal event", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    child.stdout.end(jsonl(rawEvent(0, "run.started")));
    await expectFailure(run, child, "HERMES_TRANSPORT_MISSING_TERMINAL");
  });

  it("rejects output after a terminal event", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    child.stdout.write(
      jsonl(
        rawEvent(0, "run.started"),
        rawEvent(1, "run.completed"),
        rawEvent(2, "message.delta", { text: "late" }),
      ),
    );
    await expectFailure(run, child, "HERMES_TRANSPORT_OUTPUT_AFTER_TERMINAL");
  });

  it("rejects a final JSON record without its JSONL newline", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    child.stdout.end(JSON.stringify(rawEvent(0, "run.started")));
    await expectFailure(run, child, "HERMES_TRANSPORT_TRUNCATED_OUTPUT");
  });
});

describe("Hermes transport lifecycle failures", () => {
  it("cancels idempotently while allowing a raw run.cancelled terminal", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    const eventsPromise = collect(run.events);
    child.stdout.write(jsonl(rawEvent(0, "run.started")));

    run.cancel();
    run.cancel();
    expect(child.terminateCount).toBe(1);
    child.stdout.end(
      jsonl(
        rawEvent(1, "run.cancelled", {
          cancelled_by: "orchestrator",
          reason: "Hall requested cancellation",
        }),
      ),
    );
    child.emitExit(0);

    expect((await eventsPromise).map((event) => event.type)).toEqual([
      "run.started",
      "run.cancelled",
    ]);
    await expect(run.completion).resolves.toMatchObject({
      terminalEvent: { type: "run.cancelled" },
    });
  });

  it("force-terminates and settles when cancellation produces no terminal", async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(
      options(child, { cleanupGraceMs: 100, forceTerminationTimeoutMs: 100 }),
    );

    run.cancel();
    expect(child.terminateCount).toBe(1);
    await vi.advanceTimersByTimeAsync(101);
    expect(child.forceTerminateCount).toBe(1);
    child.emitExit(null, "SIGKILL");
    child.stdout.end();

    await expect(run.completion).rejects.toBeInstanceOf(HermesTransportError);
  });

  it("reports a synchronous spawn failure without exposing the raw error", async () => {
    const spawner: HermesProcessSpawner = {
      spawn() {
        throw new Error("ENOENT /secret/python/path");
      },
    };
    const run = startHermesExecutionTransport(options(new FakeProcess(), { spawner }));
    const error = await expectFailure(run, undefined, "HERMES_TRANSPORT_SPAWN_FAILED");
    expect(JSON.stringify(error)).not.toContain("/secret/python/path");
    expect(run.currentState).toBe("failed");
  });

  it("reports an asynchronous spawn failure safely", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    child.emitError();
    const error = await expectFailure(run, undefined, "HERMES_TRANSPORT_SPAWN_FAILED");
    expect(JSON.stringify(error)).not.toContain("raw spawn detail");
  });

  it("rejects a non-zero exit without a valid terminal", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    child.stdout.end(jsonl(rawEvent(0, "run.started")));
    child.emitExit(2);
    await expect(run.completion).rejects.toBeInstanceOf(HermesTransportError);
  });

  it("terminates and force-terminates a child after protocol failure", async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(
      options(child, { cleanupGraceMs: 100, forceTerminationTimeoutMs: 100 }),
    );
    child.stdout.write("{bad-json}\n");
    expect(child.terminateCount).toBe(1);
    await vi.advanceTimersByTimeAsync(101);
    expect(child.forceTerminateCount).toBe(1);
    child.emitExit(null, "SIGKILL");
    await expect(run.completion).rejects.toMatchObject({
      code: "HERMES_TRANSPORT_MALFORMED_JSON",
    });
  });

  it("consumes but never propagates raw stderr", async () => {
    const child = new FakeProcess();
    const run = startHermesExecutionTransport(options(child));
    child.stderr.write("HERMES_ROUTER_API_KEY=raw-secret-from-stderr");
    child.stdout.write("{bad-json}\n");
    const error = await expectFailure(run, child, "HERMES_TRANSPORT_MALFORMED_JSON");
    expect(JSON.stringify(error)).not.toContain("raw-secret-from-stderr");
    expect(JSON.stringify(error)).not.toContain("HERMES_ROUTER_API_KEY");
  });
});

afterEach(() => {
  vi.useRealTimers();
});
