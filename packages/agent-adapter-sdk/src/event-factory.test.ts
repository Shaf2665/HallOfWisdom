import { describe, expect, it } from "vitest";
import { parseNormalizedAgentEvent, PROTOCOL_VERSION } from "@hall-of-wisdom/protocol";
import { EventFactory } from "./event-factory.js";

function createFactory(): EventFactory {
  return new EventFactory({ runId: "run-1", taskId: "task-1", agentId: "agent-1" });
}

describe("EventFactory", () => {
  it("starts sequence at 0", () => {
    const factory = createFactory();
    expect(factory.runStarted().sequence).toBe(0);
  });

  it("increments sequence by exactly 1 per event", () => {
    const factory = createFactory();
    const first = factory.runStarted();
    const second = factory.messageDelta("hello");
    const third = factory.runCompleted();
    expect([first.sequence, second.sequence, third.sequence]).toEqual([0, 1, 2]);
  });

  it("generates unique event IDs across many events", () => {
    const factory = createFactory();
    const ids = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      ids.add(factory.messageDelta(`chunk ${String(i)}`).eventId);
    }
    expect(ids.size).toBe(100);
  });

  it("populates every shared envelope field", () => {
    const factory = createFactory();
    const event = factory.toolStarted("call-1", "read_file");
    expect(event.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(event.runId).toBe("run-1");
    expect(event.taskId).toBe("task-1");
    expect(event.agentId).toBe("agent-1");
    expect(typeof event.eventId).toBe("string");
    expect(event.eventId.length).toBeGreaterThan(0);
    expect(typeof event.timestamp).toBe("string");
  });

  it("produces every event variant as valid, parseable NormalizedAgentEvent", () => {
    const factory = createFactory();
    const events = [
      factory.runStarted(),
      factory.messageDelta("hello"),
      factory.toolStarted("call-1", "read_file"),
      factory.toolCompleted("call-1", "read_file", true, "contents"),
      factory.fileChanged("src/index.ts", "modified"),
      factory.approvalRequired("Push to protected branch", "high"),
      factory.runCancelled("user", "changed my mind"),
    ];
    for (const event of events) {
      expect(() => parseNormalizedAgentEvent(event)).not.toThrow();
    }
  });

  it("produces a valid run.completed event", () => {
    const factory = createFactory();
    expect(() => parseNormalizedAgentEvent(factory.runCompleted("done"))).not.toThrow();
  });

  it("produces a valid run.failed event", () => {
    const factory = createFactory();
    const event = factory.runFailed({ code: "MOCK_EXECUTION_FAILED", message: "boom" });
    expect(() => parseNormalizedAgentEvent(event)).not.toThrow();
  });

  it("keeps a separate sequence counter per factory instance", () => {
    const factoryA = createFactory();
    const factoryB = createFactory();
    factoryA.runStarted();
    factoryA.messageDelta("hi");
    const eventB = factoryB.runStarted();
    expect(eventB.sequence).toBe(0);
  });
});
