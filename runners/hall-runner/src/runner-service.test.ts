import { describe, expect, it } from "vitest";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
import { parseNormalizedAgentEvent, type NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { AgentRegistry } from "./agent-registry.js";
import { runTask } from "./runner-service.js";
import { NoTerminalEventError, UnexpectedRunnerStateError, UnknownAdapterError } from "./errors.js";
import { EXIT_CODES } from "./exit-codes.js";
import { createTaskInput, FakeAdapter } from "./test-support.js";

function registryWithMockAgent(config: ConstructorParameters<typeof MockAgentAdapter>[0] = {}) {
  const registry = new AgentRegistry();
  const adapter = new MockAgentAdapter(config);
  registry.register(adapter);
  return { registry, adapterId: adapter.descriptor.adapterId };
}

describe("runTask — real Mock Agent scenarios", () => {
  it("runs the success scenario to completion", async () => {
    const { registry, adapterId } = registryWithMockAgent({
      scenario: "success",
      progressMessageCount: 1,
    });
    const events: NormalizedAgentEvent[] = [];
    const result = await runTask({
      registry,
      adapterId,
      taskInput: createTaskInput(),
      onEvent: (event) => events.push(event),
    });
    expect(result.terminalEventType).toBe("run.completed");
    expect(result.exitCode).toBe(EXIT_CODES.completed);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("runs the failure scenario to completion with a stable failure code", async () => {
    const { registry, adapterId } = registryWithMockAgent({ scenario: "failure" });
    const result = await runTask({ registry, adapterId, taskInput: createTaskInput() });
    expect(result.terminalEventType).toBe("run.failed");
    expect(result.exitCode).toBe(EXIT_CODES.failed);
    expect(result.failure?.code).toBe("MOCK_EXECUTION_FAILED");
  });

  it("runs the cancellable scenario and honors programmatic cancellation", async () => {
    const { registry, adapterId } = registryWithMockAgent({
      scenario: "cancellable",
      progressMessageCount: 5,
    });
    const controller = new AbortController();
    let sawFirstEvent = false;
    const events: NormalizedAgentEvent[] = [];

    const resultPromise = runTask({
      registry,
      adapterId,
      taskInput: createTaskInput(),
      options: { signal: controller.signal },
      onEvent: (event) => {
        events.push(event);
        if (!sawFirstEvent) {
          sawFirstEvent = true;
          controller.abort();
        }
      },
    });

    const result = await resultPromise;
    expect(result.terminalEventType).toBe("run.cancelled");
    expect(result.exitCode).toBe(EXIT_CODES.cancelled);
    expect(events.at(-1)?.type).toBe("run.cancelled");
  });

  it("every streamed event validates through parseNormalizedAgentEvent", async () => {
    const { registry, adapterId } = registryWithMockAgent({
      scenario: "success",
      progressMessageCount: 2,
    });
    const events: NormalizedAgentEvent[] = [];
    await runTask({
      registry,
      adapterId,
      taskInput: createTaskInput(),
      onEvent: (event) => events.push(event),
    });
    for (const event of events) {
      expect(() => parseNormalizedAgentEvent(event)).not.toThrow();
    }
  });

  it("streams events in ascending sequence order", async () => {
    const { registry, adapterId } = registryWithMockAgent({
      scenario: "success",
      progressMessageCount: 3,
    });
    const sequences: number[] = [];
    await runTask({
      registry,
      adapterId,
      taskInput: createTaskInput(),
      onEvent: (event) => sequences.push(event.sequence),
    });
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("accepts exactly one terminal event", async () => {
    const { registry, adapterId } = registryWithMockAgent({ scenario: "success" });
    const events: NormalizedAgentEvent[] = [];
    await runTask({
      registry,
      adapterId,
      taskInput: createTaskInput(),
      onEvent: (event) => events.push(event),
    });
    const terminalTypes = ["run.completed", "run.failed", "run.cancelled"];
    expect(events.filter((event) => terminalTypes.includes(event.type))).toHaveLength(1);
  });

  it("calls adapter.detect() exactly once before starting the task", async () => {
    const registry = new AgentRegistry();
    const adapter = new FakeAdapter({
      events: [makeEvent("run.started", 0), makeEvent("run.completed", 1)],
    });
    registry.register(adapter);
    await runTask({
      registry,
      adapterId: adapter.descriptor.adapterId,
      taskInput: createTaskInput(),
    });
    expect(adapter.detectCallCount).toBe(1);
  });

  it("reports the correct event count", async () => {
    const { registry, adapterId } = registryWithMockAgent({
      scenario: "success",
      progressMessageCount: 2,
    });
    const result = await runTask({ registry, adapterId, taskInput: createTaskInput() });
    // run.started + 2 message.delta + tool.started + tool.completed + run.completed
    expect(result.eventCount).toBe(6);
  });

  it("does not include raw environment variable values in the result", async () => {
    process.env.HALL_RUNNER_TEST_SECRET = "super-secret-value-should-not-leak";
    try {
      const { registry, adapterId } = registryWithMockAgent({ scenario: "success" });
      const result = await runTask({ registry, adapterId, taskInput: createTaskInput() });
      expect(JSON.stringify(result)).not.toContain("super-secret-value-should-not-leak");
    } finally {
      delete process.env.HALL_RUNNER_TEST_SECRET;
    }
  });
});

describe("runTask — availability and unknown-adapter handling", () => {
  it("returns a run.failed result without starting an unavailable adapter", async () => {
    const registry = new AgentRegistry();
    const adapter = new FakeAdapter({ availability: "offline", events: [] });
    registry.register(adapter);
    const result = await runTask({
      registry,
      adapterId: adapter.descriptor.adapterId,
      taskInput: createTaskInput(),
    });
    expect(result.terminalEventType).toBe("run.failed");
    expect(result.exitCode).toBe(EXIT_CODES.failed);
    expect(result.failure?.code).toBe("ADAPTER_UNAVAILABLE");
  });

  it("rejects an unknown adapter id", async () => {
    const registry = new AgentRegistry();
    await expect(
      runTask({ registry, adapterId: "hall.nonexistent", taskInput: createTaskInput() }),
    ).rejects.toThrow(UnknownAdapterError);
  });
});

describe("runTask — defensive event-stream validation", () => {
  it("rejects an event stream that ends without a terminal event", async () => {
    const registry = new AgentRegistry();
    const adapter = new FakeAdapter({ events: [makeEvent("run.started", 0)] });
    registry.register(adapter);
    await expect(
      runTask({ registry, adapterId: adapter.descriptor.adapterId, taskInput: createTaskInput() }),
    ).rejects.toThrow(NoTerminalEventError);
  });

  it("rejects a malformed event", async () => {
    const registry = new AgentRegistry();
    const malformed = { type: "run.started" } as unknown as NormalizedAgentEvent;
    const adapter = new FakeAdapter({ events: [malformed] });
    registry.register(adapter);
    await expect(
      runTask({ registry, adapterId: adapter.descriptor.adapterId, taskInput: createTaskInput() }),
    ).rejects.toThrow();
  });

  it("rejects an event received after the terminal event", async () => {
    const registry = new AgentRegistry();
    const adapter = new FakeAdapter({
      events: [
        makeEvent("run.started", 0),
        makeEvent("run.completed", 1),
        makeEvent("message.delta", 2),
      ],
    });
    registry.register(adapter);
    await expect(
      runTask({ registry, adapterId: adapter.descriptor.adapterId, taskInput: createTaskInput() }),
    ).rejects.toThrow(UnexpectedRunnerStateError);
  });
});

function makeEvent(
  type: "run.started" | "run.completed" | "message.delta",
  sequence: number,
): NormalizedAgentEvent {
  const envelope = {
    protocolVersion: "0.1" as const,
    eventId: `event-${String(sequence)}`,
    runId: "run-1",
    taskId: "task-1",
    agentId: "fake-agent",
    timestamp: "2026-07-15T12:00:00.000Z",
    sequence,
  };
  if (type === "run.started") return { ...envelope, type, payload: {} };
  if (type === "run.completed") return { ...envelope, type, payload: {} };
  return { ...envelope, type, payload: { text: "progress" } };
}
