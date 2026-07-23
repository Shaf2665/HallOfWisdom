import { describe, expect, it } from "vitest";
import { parseNormalizedAgentEvent, type NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { MockAgentAdapter } from "./mock-agent-adapter.js";
import { createTaskInput, collectEvents } from "./test-support.js";

describe("MockAgentAdapter.detect", () => {
  it("reports the Mock Agent as installed and available", async () => {
    const adapter = new MockAgentAdapter();
    const result = await adapter.detect();
    expect(result.installed).toBe(true);
    expect(result.availability).toBe("available");
  });

  it("reports executionTrust: simulated — Phase 11", async () => {
    const adapter = new MockAgentAdapter();
    const result = await adapter.detect();
    expect(result.executionTrust).toBe("simulated");
  });

  it("never reports project.edit as verified — Mock Agent is not a real editing agent", async () => {
    const adapter = new MockAgentAdapter();
    const result = await adapter.detect();
    const projectEdit = result.capabilityObservations?.find((o) => o.capability === "project.edit");
    expect(projectEdit).toBeUndefined();
  });

  it("declares only structured.events and cancellation, never project.edit", () => {
    const adapter = new MockAgentAdapter();
    expect(adapter.descriptor.declaredCapabilities).toEqual(["structured.events", "cancellation"]);
  });
});

describe("MockAgentAdapter success scenario", () => {
  it("emits a correctly ordered event sequence ending in run.completed", async () => {
    const adapter = new MockAgentAdapter({ scenario: "success", progressMessageCount: 2 });
    const run = await adapter.startTask(createTaskInput());
    const events = await collectEvents(run.events);

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "message.delta",
      "tool.started",
      "tool.completed",
      "run.completed",
    ]);
  });

  it("produces contiguous sequence numbers starting at 0", async () => {
    const adapter = new MockAgentAdapter({ scenario: "success", progressMessageCount: 3 });
    const run = await adapter.startTask(createTaskInput());
    const events = await collectEvents(run.events);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
  });

  it("emits exactly one terminal event", async () => {
    const adapter = new MockAgentAdapter({ scenario: "success" });
    const run = await adapter.startTask(createTaskInput());
    const events = await collectEvents(run.events);
    const terminalTypes = ["run.completed", "run.failed", "run.cancelled"];
    const terminalEvents = events.filter((event) => terminalTypes.includes(event.type));
    expect(terminalEvents).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("resolves completion with the run.completed event and reports currentState completed", async () => {
    const adapter = new MockAgentAdapter({ scenario: "success" });
    const run = await adapter.startTask(createTaskInput());
    await collectEvents(run.events);
    const completionEvent = await run.completion;
    expect(completionEvent.type).toBe("run.completed");
    expect(run.currentState).toBe("completed");
  });

  it("every emitted event passes parseNormalizedAgentEvent", async () => {
    const adapter = new MockAgentAdapter({ scenario: "success", progressMessageCount: 2 });
    const run = await adapter.startTask(createTaskInput());
    const events = await collectEvents(run.events);
    for (const event of events) {
      expect(() => parseNormalizedAgentEvent(event)).not.toThrow();
    }
  });
});

describe("MockAgentAdapter failure scenario", () => {
  it("ends with run.failed carrying the stable MOCK_EXECUTION_FAILED code", async () => {
    const adapter = new MockAgentAdapter({
      scenario: "failure",
      progressMessageCount: 1,
      failureRetryable: true,
    });
    const run = await adapter.startTask(createTaskInput());
    const events = await collectEvents(run.events);
    const last = events.at(-1);
    expect(last?.type).toBe("run.failed");
    if (last?.type === "run.failed") {
      expect(last.payload.failure.code).toBe("MOCK_EXECUTION_FAILED");
      expect(last.payload.failure.retryable).toBe(true);
    }
    expect(run.currentState).toBe("failed");
  });

  it("does not emit run.started followed by run.completed for the failure scenario", async () => {
    const adapter = new MockAgentAdapter({ scenario: "failure", progressMessageCount: 0 });
    const run = await adapter.startTask(createTaskInput());
    const events = await collectEvents(run.events);
    expect(events.some((event) => event.type === "run.completed")).toBe(false);
  });
});

describe("MockAgentAdapter cancellation", () => {
  it("explicit handle.cancel() ends the run with run.cancelled (cancelledBy: orchestrator)", async () => {
    const adapter = new MockAgentAdapter({
      scenario: "cancellable",
      progressMessageCount: 5,
      stepDelayMs: 0,
    });
    const run = await adapter.startTask(createTaskInput());
    const iterator = run.events[Symbol.asyncIterator]();

    const started = await iterator.next();
    if (started.done) {
      throw new Error("expected the first event to be run.started, but the iterator finished");
    }
    expect(started.value.type).toBe("run.started");

    run.cancel("user requested cancellation");

    const rest: NormalizedAgentEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      rest.push(next.value);
    }

    expect(rest).toHaveLength(1);
    expect(rest[0]?.type).toBe("run.cancelled");
    if (rest[0]?.type === "run.cancelled") {
      expect(rest[0].payload.cancelledBy).toBe("orchestrator");
    }
    expect(run.currentState).toBe("cancelled");
  });

  it("AbortSignal cancellation ends the run with run.cancelled (cancelledBy: system)", async () => {
    const adapter = new MockAgentAdapter({
      scenario: "cancellable",
      progressMessageCount: 5,
      stepDelayMs: 0,
    });
    const controller = new AbortController();
    const run = await adapter.startTask(createTaskInput(), { signal: controller.signal });
    const iterator = run.events[Symbol.asyncIterator]();

    await iterator.next(); // run.started
    controller.abort();

    const rest: NormalizedAgentEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      rest.push(next.value);
    }

    expect(rest).toHaveLength(1);
    expect(rest[0]?.type).toBe("run.cancelled");
    if (rest[0]?.type === "run.cancelled") {
      expect(rest[0].payload.cancelledBy).toBe("system");
    }
  });

  it("repeated cancellation emits only one terminal event and does not throw", async () => {
    const adapter = new MockAgentAdapter({ scenario: "cancellable", progressMessageCount: 5 });
    const run = await adapter.startTask(createTaskInput());
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next(); // run.started

    run.cancel();
    run.cancel();
    run.cancel();

    const rest: NormalizedAgentEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      rest.push(next.value);
    }
    expect(rest.filter((event) => event.type === "run.cancelled")).toHaveLength(1);

    // Cancelling again after the run has already finished must not throw.
    expect(() => {
      run.cancel();
    }).not.toThrow();
    const completionEvent = await run.completion;
    expect(completionEvent.type).toBe("run.cancelled");
  });

  it("cancellation prevents a later completion from being recorded", async () => {
    const adapter = new MockAgentAdapter({ scenario: "cancellable", progressMessageCount: 5 });
    const run = await adapter.startTask(createTaskInput());
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next(); // run.started
    run.cancel();
    const events = await collectEvents({ [Symbol.asyncIterator]: () => iterator });
    expect(events.every((event) => event.type !== "run.completed")).toBe(true);
    const completionEvent = await run.completion;
    expect(completionEvent.type).toBe("run.cancelled");
  });

  it("cancelling after natural completion does not replace the completed result", async () => {
    const adapter = new MockAgentAdapter({ scenario: "success", progressMessageCount: 0 });
    const run = await adapter.startTask(createTaskInput());
    await collectEvents(run.events);
    expect(run.currentState).toBe("completed");

    expect(() => {
      run.cancel("too late");
    }).not.toThrow();

    const completionEvent = await run.completion;
    expect(completionEvent.type).toBe("run.completed");
    expect(run.currentState).toBe("completed");
  });

  it("cancelling after a failure does not replace the failed result", async () => {
    const adapter = new MockAgentAdapter({ scenario: "failure", progressMessageCount: 0 });
    const run = await adapter.startTask(createTaskInput());
    await collectEvents(run.events);
    expect(run.currentState).toBe("failed");

    expect(() => {
      run.cancel("too late");
    }).not.toThrow();

    const completionEvent = await run.completion;
    expect(completionEvent.type).toBe("run.failed");
  });

  it("no events are emitted after the terminal event for a cancelled run", async () => {
    const adapter = new MockAgentAdapter({ scenario: "cancellable", progressMessageCount: 5 });
    const run = await adapter.startTask(createTaskInput());
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();
    run.cancel();
    const rest = await collectEvents({ [Symbol.asyncIterator]: () => iterator });
    expect(rest).toHaveLength(1);
    expect(rest[0]?.type).toBe("run.cancelled");
  });

  it("follows the documented immediate-abort policy: no run.started, exactly one run.cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new MockAgentAdapter({ scenario: "success", progressMessageCount: 3 });
    const run = await adapter.startTask(createTaskInput(), { signal: controller.signal });
    const events = await collectEvents(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.cancelled");
  });

  it("interrupts a pending step delay promptly instead of waiting it out", async () => {
    const adapter = new MockAgentAdapter({
      scenario: "cancellable",
      progressMessageCount: 5,
      stepDelayMs: 200,
    });
    const run = await adapter.startTask(createTaskInput());
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next(); // run.started

    const start = Date.now();
    run.cancel();
    await iterator.next(); // should resolve almost immediately, not after 200ms
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});

describe("MockAgentAdapter configuration validation", () => {
  it("rejects invalid configuration at construction", () => {
    // Deliberately bypassing the compile-time enum to prove the runtime
    // trust boundary (parseMockAgentConfig) rejects it too.
    const invalidConfig = { scenario: "not-a-scenario" } as unknown as ConstructorParameters<
      typeof MockAgentAdapter
    >[0];
    expect(() => new MockAgentAdapter(invalidConfig)).toThrow();
  });
});
