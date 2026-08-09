import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { describe, expect, it } from "vitest";
import type {
  HermesExecutionCompletion,
  HermesExecutionProcessState,
  HermesExecutionTransportOptions,
  HermesExecutionTransportRun,
} from "./execution-transport.js";
import { HermesRun, type HermesExecutionTransportStarter } from "./hermes-run.js";
import { HERMES_PROTOCOL_VERSION, type HermesRawEvent } from "./hermes-protocol.js";

class TestEventStream<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter({ value: item, done: false });
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class FakeTransportRun implements HermesExecutionTransportRun {
  readonly #stream = new TestEventStream<HermesRawEvent>();
  readonly events = this.#stream;
  readonly completion: Promise<HermesExecutionCompletion>;
  #resolve!: (completion: HermesExecutionCompletion) => void;
  #reject!: (error: Error) => void;
  #state: HermesExecutionProcessState = "running";
  #settled = false;
  cancelCount = 0;

  constructor() {
    this.completion = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    void this.completion.catch(() => undefined);
  }

  get currentState(): HermesExecutionProcessState {
    return this.#state;
  }

  emit(event: HermesRawEvent): void {
    this.#stream.push(event);
  }

  complete(terminalEvent: HermesRawEvent): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#stream.push(terminalEvent);
    this.#stream.close();
    this.#state = "exited";
    this.#resolve({
      terminalEvent: terminalEvent as HermesExecutionCompletion["terminalEvent"],
      exitCode: terminalEvent.type === "run.failed" ? 1 : 0,
      signal: null,
    });
  }

  fail(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#stream.close();
    this.#state = "failed";
    this.#reject(new Error("raw secret transport detail"));
  }

  cancel(): void {
    this.cancelCount += 1;
    this.fail();
  }
}

function rawEvent(
  sequence: number,
  type: HermesRawEvent["type"],
  payload: Readonly<Record<string, unknown>> = {},
): HermesRawEvent {
  return {
    protocol: HERMES_PROTOCOL_VERSION,
    runtime_version: "0.1.0",
    run_id: "run-1",
    sequence,
    type,
    payload,
  };
}

function runWith(
  fake: FakeTransportRun,
  overrides: Partial<ConstructorParameters<typeof HermesRun>[0]> = {},
): { readonly run: HermesRun; readonly calls: HermesExecutionTransportOptions[] } {
  const calls: HermesExecutionTransportOptions[] = [];
  const startTransport: HermesExecutionTransportStarter = (options) => {
    calls.push(options);
    return fake;
  };
  return {
    calls,
    run: new HermesRun({
      pythonExecutable: "python",
      runnerPath: "/opt/Hermes Router/hermes_agent_runner.py",
      workingDirectory: "/worktrees/task one",
      env: { SAFE: "value" },
      prompt: "Do the task.",
      runId: "run-1",
      platform: "linux",
      taskId: "task-1",
      agentId: "hermes-router",
      startTransport,
      ...overrides,
    }),
  };
}

async function collect(
  events: AsyncIterable<NormalizedAgentEvent>,
): Promise<NormalizedAgentEvent[]> {
  const collected: NormalizedAgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("HermesRun lifecycle", () => {
  it("starts transport lazily and resolves completion with the exact emitted terminal", async () => {
    const fake = new FakeTransportRun();
    const { run, calls } = runWith(fake);
    expect(calls).toHaveLength(0);
    expect(run.currentState).toBe("running");

    const eventsPromise = collect(run.events);
    expect(calls).toHaveLength(1);
    fake.emit(rawEvent(0, "run.started"));
    fake.emit(rawEvent(1, "message.delta", { text: "HERMES_HALL_EVENTS_OK" }));
    fake.complete(rawEvent(2, "run.completed", { summary: "Done" }));

    const events = await eventsPromise;
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "run.completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(await run.completion).toBe(events[2]);
    expect(run.currentState).toBe("completed");
  });

  it("turns a transport failure into one safe run.failed", async () => {
    const fake = new FakeTransportRun();
    const { run } = runWith(fake);
    const eventsPromise = collect(run.events);
    fake.emit(rawEvent(0, "run.started"));
    fake.fail();

    const events = await eventsPromise;
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.failed"]);
    expect(events[1]).toMatchObject({
      payload: { failure: { code: "HERMES_TRANSPORT_FAILURE" } },
    });
    expect(JSON.stringify(events)).not.toContain("raw secret transport detail");
    expect(await run.completion).toBe(events[1]);
    expect(run.currentState).toBe("failed");
  });

  it("turns an invalid event payload into a safe failure and cleans up transport", async () => {
    const fake = new FakeTransportRun();
    const { run } = runWith(fake);
    const eventsPromise = collect(run.events);
    fake.emit(rawEvent(0, "run.started"));
    fake.emit(rawEvent(1, "message.delta", { text: 42 }));

    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { failure: { code: "HERMES_INVALID_EVENT" } },
    });
    expect(fake.cancelCount).toBe(1);
  });

  it("cancels before iteration without starting transport", async () => {
    const fake = new FakeTransportRun();
    const { run, calls } = runWith(fake);
    run.cancel("  no longer needed  ");
    run.cancel("ignored duplicate");

    const events = await collect(run.events);
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "run.cancelled",
      payload: { cancelledBy: "orchestrator", reason: "no longer needed" },
    });
    expect(await run.completion).toBe(events[0]);
    expect(run.currentState).toBe("cancelled");
  });

  it("cancels a running transport idempotently and synthesizes one terminal", async () => {
    const fake = new FakeTransportRun();
    const { run } = runWith(fake);
    const eventsPromise = collect(run.events);
    fake.emit(rawEvent(0, "run.started"));
    await nextTurn();
    run.cancel("stop");
    run.cancel("stop again");

    const events = await eventsPromise;
    expect(fake.cancelCount).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.cancelled"]);
  });

  it("supports an external AbortSignal before and during execution", async () => {
    const beforeController = new AbortController();
    beforeController.abort();
    const before = runWith(new FakeTransportRun(), { signal: beforeController.signal });
    expect((await collect(before.run.events))[0]?.type).toBe("run.cancelled");
    expect(before.calls).toHaveLength(0);

    const duringController = new AbortController();
    const duringFake = new FakeTransportRun();
    const during = runWith(duringFake, { signal: duringController.signal });
    const eventsPromise = collect(during.run.events);
    duringFake.emit(rawEvent(0, "run.started"));
    await nextTurn();
    duringController.abort();
    expect((await eventsPromise).at(-1)?.type).toBe("run.cancelled");
    expect(duringFake.cancelCount).toBe(1);
  });

  it.each([
    ["run.completed", "completed"],
    ["run.failed", "failed"],
  ] as const)("preserves a raw %s terminal against late cancellation", async (type, state) => {
    const fake = new FakeTransportRun();
    const { run } = runWith(fake);
    const eventsPromise = collect(run.events);
    fake.emit(rawEvent(0, "run.started"));
    fake.complete(
      type === "run.failed"
        ? rawEvent(1, type, { code: "SAFE_FAILURE", message: "Safe failure." })
        : rawEvent(1, type, {}),
    );
    await nextTurn();
    run.cancel("too late");

    const events = await eventsPromise;
    expect(events.at(-1)?.type).toBe(type);
    expect(run.currentState).toBe(state);
    expect(fake.cancelCount).toBe(0);
  });

  it("maps a raw Hermes cancellation normally", async () => {
    const fake = new FakeTransportRun();
    const { run } = runWith(fake);
    const eventsPromise = collect(run.events);
    fake.emit(rawEvent(0, "run.started"));
    fake.complete(
      rawEvent(1, "run.cancelled", { cancelled_by: "system", reason: "Runtime stopped" }),
    );

    expect((await eventsPromise).at(-1)).toMatchObject({
      type: "run.cancelled",
      payload: { cancelledBy: "system", reason: "Runtime stopped" },
    });
  });

  it("never lets duplicate or late raw terminal records escape", async () => {
    const fake = new FakeTransportRun();
    const { run } = runWith(fake);
    const eventsPromise = collect(run.events);
    fake.emit(rawEvent(0, "run.started"));
    fake.emit(rawEvent(1, "run.completed", {}));
    fake.complete(rawEvent(2, "run.failed", { code: "SAFE_FAILURE", message: "Failed" }));

    const events = await eventsPromise;
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.failed"]);
    expect(events.filter((event) => event.type.startsWith("run.")).slice(1)).toHaveLength(1);
  });
});
