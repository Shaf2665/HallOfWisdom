import { describe, expect, it } from "vitest";
import { parseNormalizedAgentEvent, type NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { EventStore, EventStoreConfigError, MIN_EVENTS_PER_TASK } from "./event-store.js";
import {
  EventAfterTerminalError,
  EventCapacityReachedError,
  EventIdentityMismatchError,
  EventSequenceConflictError,
  EventSequenceGapError,
} from "./event-store-errors.js";

const IDENTITY = { runId: "run-1", taskId: "task-1", agentId: "mock-agent" };

function makeEvent(
  type: NormalizedAgentEvent["type"],
  sequence: number,
  overrides: Partial<Pick<typeof IDENTITY, "runId" | "taskId" | "agentId">> & {
    eventId?: string;
  } = {},
): NormalizedAgentEvent {
  const envelope = {
    protocolVersion: "0.1" as const,
    eventId: overrides.eventId ?? `event-${String(sequence)}`,
    runId: overrides.runId ?? IDENTITY.runId,
    taskId: overrides.taskId ?? IDENTITY.taskId,
    agentId: overrides.agentId ?? IDENTITY.agentId,
    timestamp: "2026-07-15T12:00:00.000Z",
    sequence,
  };
  if (type === "run.started" || type === "run.completed") {
    return { ...envelope, type, payload: {} };
  }
  if (type === "run.cancelled") {
    return { ...envelope, type, payload: { cancelledBy: "system" } };
  }
  return { ...envelope, type: "message.delta", payload: { text: "progress" } };
}

describe("EventStore", () => {
  it("accepts the first event at sequence 0", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    const result = store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    expect(result).toEqual({ stored: true, duplicate: false });
  });

  it("accepts contiguous events", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    store.append("task-1", makeEvent("message.delta", 1), IDENTITY);
    store.append("task-1", makeEvent("run.completed", 2), IDENTITY);
    expect(store.list("task-1")).toHaveLength(3);
  });

  it("treats a re-delivery with the same sequence and eventId as an idempotent duplicate", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    const event = makeEvent("run.started", 0);
    store.append("task-1", event, IDENTITY);
    const result = store.append("task-1", event, IDENTITY);
    expect(result).toEqual({ stored: false, duplicate: true });
    expect(store.list("task-1")).toHaveLength(1);
  });

  it("rejects a conflicting event at an already-occupied sequence with a different eventId", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    store.append("task-1", makeEvent("run.started", 0, { eventId: "event-a" }), IDENTITY);
    expect(() =>
      store.append("task-1", makeEvent("run.started", 0, { eventId: "event-b" }), IDENTITY),
    ).toThrow(EventSequenceConflictError);
  });

  it("rejects a sequence gap", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    expect(() => store.append("task-1", makeEvent("run.completed", 2), IDENTITY)).toThrow(
      EventSequenceGapError,
    );
  });

  it("rejects an out-of-order event whose sequence is lower than the next expected slot but unknown", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    store.append("task-1", makeEvent("message.delta", 1), IDENTITY);
    // sequence 0 is occupied by a different eventId than this one -> conflict, not silently reordered
    expect(() =>
      store.append("task-1", makeEvent("run.started", 0, { eventId: "different" }), IDENTITY),
    ).toThrow(EventSequenceConflictError);
  });

  it("rejects any event after a terminal event, even one that would otherwise be 'next'", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    store.append("task-1", makeEvent("run.completed", 1), IDENTITY);
    expect(() => store.append("task-1", makeEvent("message.delta", 2), IDENTITY)).toThrow(
      EventAfterTerminalError,
    );
  });

  it("does not publish a duplicate terminal event twice (the append result says so)", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    const completed = makeEvent("run.completed", 1);
    store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    store.append("task-1", completed, IDENTITY);
    const secondAttempt = store.append("task-1", completed, IDENTITY);
    expect(secondAttempt.duplicate).toBe(true);
  });

  it("rejects a runId mismatch", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    expect(() =>
      store.append("task-1", makeEvent("run.started", 0, { runId: "wrong-run" }), IDENTITY),
    ).toThrow(EventIdentityMismatchError);
  });

  it("rejects a taskId mismatch", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    expect(() =>
      store.append("task-1", makeEvent("run.started", 0, { taskId: "wrong-task" }), IDENTITY),
    ).toThrow(EventIdentityMismatchError);
  });

  it("rejects an agentId mismatch", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    expect(() =>
      store.append("task-1", makeEvent("run.started", 0, { agentId: "wrong-agent" }), IDENTITY),
    ).toThrow(EventIdentityMismatchError);
  });

  it("constructor rejects a maxEventsPerTask below the minimum usable value", () => {
    expect(() => new EventStore({ maxEventsPerTask: MIN_EVENTS_PER_TASK - 1 })).toThrow(
      EventStoreConfigError,
    );
    expect(() => new EventStore({ maxEventsPerTask: 0 })).toThrow(EventStoreConfigError);
  });

  it("constructor accepts the minimum usable maxEventsPerTask", () => {
    expect(() => new EventStore({ maxEventsPerTask: MIN_EVENTS_PER_TASK })).not.toThrow();
  });

  it("reserves the last slot for a terminal event: a non-terminal event is rejected once maxEventsPerTask - 1 events are stored", () => {
    const store = new EventStore({ maxEventsPerTask: 2 });
    store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    expect(() => store.append("task-1", makeEvent("message.delta", 1), IDENTITY)).toThrow(
      EventCapacityReachedError,
    );
  });

  it("still accepts a terminal event in the reserved last slot even though a non-terminal event there would be rejected", () => {
    const store = new EventStore({ maxEventsPerTask: 2 });
    store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    const result = store.append("task-1", makeEvent("run.completed", 1), IDENTITY);
    expect(result).toEqual({ stored: true, duplicate: false });
    expect(store.list("task-1")).toHaveLength(2);
  });

  it("a normal run.started + terminal lifecycle fits inside the minimum configured limit", () => {
    const store = new EventStore({ maxEventsPerTask: MIN_EVENTS_PER_TASK });
    store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    const result = store.append("task-1", makeEvent("run.completed", 1), IDENTITY);
    expect(result.stored).toBe(true);
  });

  it("nextSequence reflects how many events are already stored, including for an unknown task", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    expect(store.nextSequence("task-1")).toBe(0);
    store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    expect(store.nextSequence("task-1")).toBe(1);
  });

  it("every accepted event passes parseNormalizedAgentEvent", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    const events = [
      makeEvent("run.started", 0),
      makeEvent("message.delta", 1),
      makeEvent("run.completed", 2),
    ];
    for (const event of events) store.append("task-1", event, IDENTITY);
    for (const stored of store.list("task-1")) {
      expect(() => parseNormalizedAgentEvent(stored)).not.toThrow();
    }
  });

  it("list(taskId, afterSequence) returns only events with a greater sequence", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    store.append("task-1", makeEvent("message.delta", 1), IDENTITY);
    store.append("task-1", makeEvent("message.delta", 2), IDENTITY);
    store.append("task-1", makeEvent("run.completed", 3), IDENTITY);
    const replay = store.list("task-1", 1);
    expect(replay.map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("list(taskId) with no afterSequence returns everything", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    store.append("task-1", makeEvent("run.started", 0), IDENTITY);
    store.append("task-1", makeEvent("run.completed", 1), IDENTITY);
    expect(store.list("task-1")).toHaveLength(2);
  });

  it("list() for an unknown task returns an empty array rather than throwing", () => {
    const store = new EventStore({ maxEventsPerTask: 100 });
    expect(store.list("nonexistent")).toEqual([]);
  });
});
