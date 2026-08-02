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

    // Phase 15.2 — governed-retry stream reopening. See
    // `EventStore.reopenForRetry()`'s doc comment: clears the terminal
    // marker so a fresh run's events can append, CONTINUING the same
    // per-task sequence — never resetting, never renumbering, never
    // deleting. Both backends return `false` (never throw) on any
    // precondition failure — see either implementation's own doc comment.
    describe("reopenForRetry", () => {
      it("accepts the exact expected terminal sequence", () => {
        const store = createStore();
        store.append("stream-1", terminalEvent(0), IDENTITY);
        expect(store.reopenForRetry("stream-1", 0)).toBe(true);
      });

      it("preserves the old terminal event row unchanged after reopening", () => {
        const store = createStore();
        store.append("stream-1", terminalEvent(0), IDENTITY);
        store.reopenForRetry("stream-1", 0);
        const [event] = store.list("stream-1");
        expect(event).toEqual(terminalEvent(0));
      });

      it("reopens the stream without deleting history — old and new events all remain listed", () => {
        const store = createStore();
        store.append("stream-1", terminalEvent(0), IDENTITY);
        store.reopenForRetry("stream-1", 0);
        store.append("stream-1", makeEvent(1), IDENTITY);
        store.append("stream-1", terminalEvent(2), IDENTITY);
        expect(store.list("stream-1").map((e) => e.sequence)).toEqual([0, 1, 2]);
      });

      it("nextSequence stays cumulative — never resets to 0 after reopening", () => {
        const store = createStore();
        store.append("stream-1", makeEvent(0), IDENTITY);
        store.append("stream-1", terminalEvent(1), IDENTITY);
        store.reopenForRetry("stream-1", 1);
        expect(store.nextSequence("stream-1")).toBe(2);
        store.append("stream-1", makeEvent(2), IDENTITY);
        expect(store.nextSequence("stream-1")).toBe(3);
      });

      it("rejects a stale terminal sequence that doesn't match the actual last event", () => {
        const store = createStore();
        store.append("stream-1", terminalEvent(0), IDENTITY);
        expect(store.reopenForRetry("stream-1", 5)).toBe(false);
      });

      it("rejects reopening a stream with no terminal event at all", () => {
        const store = createStore();
        store.append("stream-1", makeEvent(0), IDENTITY);
        expect(store.reopenForRetry("stream-1", 0)).toBe(false);
      });

      it("rejects a repeated reopen at the same, now-superseded sequence — but a later valid terminal sequence still reopens fine", () => {
        const store = createStore();
        store.append("stream-1", terminalEvent(0), IDENTITY);
        expect(store.reopenForRetry("stream-1", 0)).toBe(true);
        store.append("stream-1", makeEvent(1), IDENTITY);
        store.append("stream-1", terminalEvent(2), IDENTITY);
        // The old, now-superseded terminal sequence no longer reopens.
        expect(store.reopenForRetry("stream-1", 0)).toBe(false);
        // The new, currently-terminal sequence reopens fine — a task can
        // legitimately go through several retry attempts over its lifetime,
        // not just one.
        expect(store.reopenForRetry("stream-1", 2)).toBe(true);
      });

      it("of two competing reopen calls at the same expected terminal sequence, exactly one succeeds", () => {
        const store = createStore();
        store.append("stream-1", terminalEvent(0), IDENTITY);
        expect(store.reopenForRetry("stream-1", 0)).toBe(true);
        expect(store.reopenForRetry("stream-1", 0)).toBe(false);
      });

      it("attempt-2 events appended after a reopen have sequence numbers strictly greater than every attempt-1 event's sequence", () => {
        const store = createStore();
        store.append("stream-1", makeEvent(0), IDENTITY);
        store.append("stream-1", terminalEvent(1), IDENTITY);
        const attempt1MaxSequence = Math.max(...store.list("stream-1").map((e) => e.sequence));
        store.reopenForRetry("stream-1", 1);
        store.append("stream-1", makeEvent(2), IDENTITY);
        store.append("stream-1", terminalEvent(3), IDENTITY);
        const attempt2Sequences = store
          .list("stream-1", attempt1MaxSequence)
          .map((e) => e.sequence);
        expect(attempt2Sequences).toEqual([2, 3]);
        for (const sequence of attempt2Sequences) {
          expect(sequence).toBeGreaterThan(attempt1MaxSequence);
        }
      });

      it("a rejected reopen call leaves the terminal state completely unchanged", () => {
        const store = createStore();
        store.append("stream-1", terminalEvent(0), IDENTITY);
        const before = store.list("stream-1");
        const nextSequenceBefore = store.nextSequence("stream-1");
        expect(store.reopenForRetry("stream-1", 99)).toBe(false);
        expect(store.list("stream-1")).toEqual(before);
        expect(store.nextSequence("stream-1")).toBe(nextSequenceBefore);
        // Still genuinely terminal — cannot append past it.
        expect(() => store.append("stream-1", makeEvent(1), IDENTITY)).toThrow(
          EventAfterTerminalError,
        );
      });
    });
  });
}
