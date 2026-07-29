import { describe, expect, it } from "vitest";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import {
  EventAfterTerminalError,
  EventSequenceConflictError,
  EventSequenceGapError,
  EventIdentityMismatchError,
} from "./event-store-errors.js";
import type { NormalizedEventStorePort } from "./event-store-port.js";

const IDENTITY = { runId: "run-1", taskId: "stream-1", agentId: "agent-1" };

function makeEvent(
  sequence: number,
  overrides: Partial<NormalizedAgentEvent> = {},
): NormalizedAgentEvent {
  return {
    protocolVersion: "0.1",
    eventId: `event-${String(sequence)}`,
    runId: IDENTITY.runId,
    taskId: IDENTITY.taskId,
    agentId: IDENTITY.agentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    sequence,
    type: "message.delta",
    payload: { text: "hello" },
    ...overrides,
  } as NormalizedAgentEvent;
}

function terminalEvent(sequence: number): NormalizedAgentEvent {
  return makeEvent(sequence, { type: "run.completed", payload: {} });
}

/**
 * Behavioral contract every `NormalizedEventStorePort` implementation must
 * satisfy — run once against the in-memory `EventStore` and once against
 * `SqliteEventStore` (Phase 13's durable-mode sibling), for both the task
 * and comparison-candidate stream kinds.
 */
export function defineEventStoreContractTests(
  label: string,
  createStore: (maxEventsPerStream?: number) => NormalizedEventStorePort,
): void {
  describe(`NormalizedEventStorePort contract (${label})`, () => {
    it("appends events at the expected next sequence", () => {
      const store = createStore();
      expect(store.append("stream-1", makeEvent(0), IDENTITY)).toEqual({
        stored: true,
        duplicate: false,
      });
      expect(store.append("stream-1", makeEvent(1), IDENTITY)).toEqual({
        stored: true,
        duplicate: false,
      });
      expect(store.list("stream-1").map((e) => e.sequence)).toEqual([0, 1]);
    });

    it("a duplicate append (same sequence, same eventId) is an idempotent no-op", () => {
      const store = createStore();
      store.append("stream-1", makeEvent(0), IDENTITY);
      const result = store.append("stream-1", makeEvent(0), IDENTITY);
      expect(result).toEqual({ stored: false, duplicate: true });
      expect(store.list("stream-1")).toHaveLength(1);
    });

    it("a conflicting append (same sequence, different eventId) is rejected", () => {
      const store = createStore();
      store.append("stream-1", makeEvent(0), IDENTITY);
      expect(() =>
        store.append("stream-1", makeEvent(0, { eventId: "different-event" }), IDENTITY),
      ).toThrow(EventSequenceConflictError);
    });

    it("a sequence gap is rejected", () => {
      const store = createStore();
      expect(() => store.append("stream-1", makeEvent(1), IDENTITY)).toThrow(EventSequenceGapError);
    });

    it("rejects an identity mismatch", () => {
      const store = createStore();
      expect(() =>
        store.append("stream-1", makeEvent(0, { runId: "wrong-run" }), IDENTITY),
      ).toThrow(EventIdentityMismatchError);
    });

    it("a terminal event remains terminal — no second terminal event may be appended", () => {
      const store = createStore();
      store.append("stream-1", makeEvent(0), IDENTITY);
      store.append("stream-1", terminalEvent(1), IDENTITY);
      expect(() => store.append("stream-1", makeEvent(2), IDENTITY)).toThrow(
        EventAfterTerminalError,
      );
    });

    it("re-appending the exact same terminal event again is still an idempotent no-op, not a second terminal event", () => {
      const store = createStore();
      store.append("stream-1", terminalEvent(0), IDENTITY);
      const result = store.append("stream-1", terminalEvent(0), IDENTITY);
      expect(result).toEqual({ stored: false, duplicate: true });
    });

    it("nextSequence reflects the current stream length", () => {
      const store = createStore();
      expect(store.nextSequence("stream-1")).toBe(0);
      store.append("stream-1", makeEvent(0), IDENTITY);
      expect(store.nextSequence("stream-1")).toBe(1);
    });

    it("list(afterSequence) returns only events strictly after the given sequence", () => {
      const store = createStore();
      store.append("stream-1", makeEvent(0), IDENTITY);
      store.append("stream-1", makeEvent(1), IDENTITY);
      store.append("stream-1", makeEvent(2), IDENTITY);
      expect(store.list("stream-1", 0).map((e) => e.sequence)).toEqual([1, 2]);
    });

    it("two different stream ids are completely independent", () => {
      const store = createStore();
      store.append("stream-a", makeEvent(0, { taskId: "stream-a" }), {
        ...IDENTITY,
        taskId: "stream-a",
      });
      expect(store.list("stream-b")).toHaveLength(0);
      expect(store.nextSequence("stream-b")).toBe(0);
    });

    it("history is bounded by maxEventsPerStream, always reserving the last slot for a terminal event", () => {
      const store = createStore(3);
      store.append("stream-1", makeEvent(0), IDENTITY);
      store.append("stream-1", makeEvent(1), IDENTITY);
      // Non-terminal events are rejected once only the reserved terminal slot remains.
      expect(() => store.append("stream-1", makeEvent(2), IDENTITY)).toThrow(/capacity/i);
      // The terminal event may still take that final reserved slot.
      const result = store.append("stream-1", terminalEvent(2), IDENTITY);
      expect(result).toEqual({ stored: true, duplicate: false });
    });
  });
}
