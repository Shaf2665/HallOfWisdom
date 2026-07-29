import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import type { AppendResult, ExpectedEventIdentity } from "./event-store.js";

/**
 * Extracted, unchanged, from `EventStore`'s own existing public method
 * signatures (Phase 13). `SqliteEventStore` is the durable-mode sibling —
 * see that class's doc comment for how one physical table serves both the
 * task-scoped and comparison-candidate-scoped streams this interface is
 * used for today, without either ever being able to see the other's
 * events.
 */
export interface NormalizedEventStorePort {
  append(
    streamId: string,
    event: NormalizedAgentEvent,
    expected: ExpectedEventIdentity,
  ): AppendResult;
  list(streamId: string, afterSequence?: number): NormalizedAgentEvent[];
  nextSequence(streamId: string): number;
}
