import { isTerminalEventType } from "@hall-of-wisdom/hall-runner";
import { parseNormalizedAgentEvent, type NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import type { HallDatabase } from "../persistence/database.js";
import { withTransaction } from "../persistence/transaction.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import type { NormalizedEventStorePort } from "./event-store-port.js";
import type { AppendResult, ExpectedEventIdentity } from "./event-store.js";
import {
  EventAfterTerminalError,
  EventCapacityReachedError,
  EventIdentityMismatchError,
  EventSequenceConflictError,
  EventSequenceGapError,
} from "./event-store-errors.js";
import { MIN_EVENTS_PER_TASK, EventStoreConfigError } from "./event-store.js";

export type EventStreamKind = "task" | "comparison_candidate";

export interface SqliteEventStoreOptions {
  readonly db: HallDatabase;
  /**
   * Fixed at construction — every call this instance makes is scoped to
   * this one stream kind. Composition builds one instance per kind (task,
   * comparison-candidate), mirroring the two independent in-memory
   * `EventStore` pairs already built today — see this class's own doc
   * comment for why that structurally prevents cross-stream leakage.
   */
  readonly streamKind: EventStreamKind;
  readonly maxEventsPerStream: number;
}

interface EventRow {
  sequence: number;
  event_id: string;
  is_terminal: number;
  payload_json: string;
}

/**
 * SQLite-backed durable sibling of `EventStore` — implements the identical
 * `NormalizedEventStorePort` contract, verified by the shared contract-test
 * suite in `event-store.contract-test.ts`. Backed by one physical `events`
 * table shared by both task and comparison-candidate streams, discriminated
 * by `stream_kind` — every query this class issues filters on
 * `(stream_kind, stream_id)` together, and the schema's own
 * `UNIQUE(stream_kind, stream_id, sequence)` constraint makes it
 * structurally impossible for two different `(streamKind, streamId)` pairs
 * to collide, so candidate A's events can never be mistaken for candidate
 * B's, and a task's events can never appear as a comparison candidate's
 * (or vice versa) even if a caller reused the same raw id string across
 * both — the `stream_kind` this instance was constructed with is always
 * part of the key.
 */
export class SqliteEventStore implements NormalizedEventStorePort {
  readonly #db: HallDatabase;
  readonly #streamKind: EventStreamKind;
  readonly #maxEventsPerStream: number;

  constructor(options: SqliteEventStoreOptions) {
    if (options.maxEventsPerStream < MIN_EVENTS_PER_TASK) {
      throw new EventStoreConfigError(options.maxEventsPerStream);
    }
    this.#db = options.db;
    this.#streamKind = options.streamKind;
    this.#maxEventsPerStream = options.maxEventsPerStream;
  }

  append(
    streamId: string,
    event: NormalizedAgentEvent,
    expected: ExpectedEventIdentity,
  ): AppendResult {
    if (event.runId !== expected.runId) {
      throw new EventIdentityMismatchError(streamId, "runId", expected.runId, event.runId);
    }
    if (event.taskId !== expected.taskId) {
      throw new EventIdentityMismatchError(streamId, "taskId", expected.taskId, event.taskId);
    }
    if (event.agentId !== expected.agentId) {
      throw new EventIdentityMismatchError(streamId, "agentId", expected.agentId, event.agentId);
    }

    return withTransaction(this.#db, () => {
      const length = this.#streamLength(streamId);

      if (event.sequence < length) {
        const existing = this.#db
          .prepare(
            "SELECT event_id FROM events WHERE stream_kind = ? AND stream_id = ? AND sequence = ?",
          )
          .get(this.#streamKind, streamId, event.sequence) as { event_id: string } | undefined;
        if (existing?.event_id === event.eventId) {
          return { stored: false, duplicate: true };
        }
        throw new EventSequenceConflictError(streamId, event.sequence);
      }

      if (event.sequence > length) {
        throw new EventSequenceGapError(streamId, event.sequence, length);
      }

      const terminalSequence = this.#terminalSequence(streamId);
      if (terminalSequence !== undefined) {
        throw new EventAfterTerminalError(streamId, event.sequence, terminalSequence);
      }

      const isTerminal = isTerminalEventType(event.type);
      const capacityLimit = isTerminal ? this.#maxEventsPerStream : this.#maxEventsPerStream - 1;
      if (length >= capacityLimit) {
        throw new EventCapacityReachedError(streamId, this.#maxEventsPerStream);
      }

      this.#db
        .prepare(
          `INSERT INTO events (
            stream_kind, stream_id, sequence, event_id, run_id, task_id, agent_id,
            event_type, is_terminal, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.#streamKind,
          streamId,
          event.sequence,
          event.eventId,
          event.runId,
          event.taskId,
          event.agentId,
          event.type,
          isTerminal ? 1 : 0,
          JSON.stringify(event),
          event.timestamp,
        );
      return { stored: true, duplicate: false };
    });
  }

  list(streamId: string, afterSequence?: number): NormalizedAgentEvent[] {
    const rows =
      afterSequence === undefined
        ? (this.#db
            .prepare(
              "SELECT * FROM events WHERE stream_kind = ? AND stream_id = ? ORDER BY sequence ASC",
            )
            .all(this.#streamKind, streamId) as unknown as EventRow[])
        : (this.#db
            .prepare(
              "SELECT * FROM events WHERE stream_kind = ? AND stream_id = ? AND sequence > ? ORDER BY sequence ASC",
            )
            .all(this.#streamKind, streamId, afterSequence) as unknown as EventRow[]);
    return rows.map((row) => this.#rowToEvent(streamId, row));
  }

  nextSequence(streamId: string): number {
    return this.#streamLength(streamId);
  }

  #streamLength(streamId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE stream_kind = ? AND stream_id = ?")
      .get(this.#streamKind, streamId) as { c: number };
    return row.c;
  }

  #terminalSequence(streamId: string): number | undefined {
    const row = this.#db
      .prepare(
        "SELECT sequence FROM events WHERE stream_kind = ? AND stream_id = ? AND is_terminal = 1 LIMIT 1",
      )
      .get(this.#streamKind, streamId) as { sequence: number } | undefined;
    return row?.sequence;
  }

  #rowToEvent(streamId: string, row: EventRow): NormalizedAgentEvent {
    try {
      const parsed: unknown = JSON.parse(row.payload_json);
      return parseNormalizedAgentEvent(parsed);
    } catch (error) {
      throw new CorruptRecordError(
        "events",
        `${this.#streamKind}:${streamId}:${String(row.sequence)}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
