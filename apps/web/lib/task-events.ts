import {
  ProtocolValidationError,
  parseNormalizedAgentEvent,
  type NormalizedAgentEvent,
} from "@hall-of-wisdom/protocol";

export interface EventIdentity {
  readonly taskId: string;
  /** `null` until the first accepted event establishes it. */
  readonly runId: string | null;
  readonly agentId: string | null;
}

export type EventValidationOutcome =
  | { readonly kind: "accepted"; readonly event: NormalizedAgentEvent }
  | { readonly kind: "duplicate"; readonly event: NormalizedAgentEvent }
  | { readonly kind: "conflict"; readonly event: NormalizedAgentEvent }
  | { readonly kind: "gap"; readonly event: NormalizedAgentEvent }
  | {
      readonly kind: "identity-mismatch";
      readonly field: "taskId" | "runId" | "agentId";
      readonly event: NormalizedAgentEvent;
    }
  | { readonly kind: "invalid"; readonly reason: string };

const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled"]);

export function isTerminalEvent(event: NormalizedAgentEvent): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

/**
 * Parses raw WebSocket message text into a schema-validated
 * `NormalizedAgentEvent`, then classifies it against everything already
 * accepted for this task — mirroring, client-side, the exact
 * duplicate/conflict/gap policy Hall Core's own `EventStore.append()`
 * enforces server-side (see `docs/architecture/0004-hall-core-server.md`,
 * "Event sequencing and duplicate policy"). Hall Core already enforces
 * these invariants before ever publishing an event, but this client does
 * not trust that blindly — the same defense-in-depth reasoning Hall Core
 * itself applies to adapter-produced events.
 *
 * `acceptedEvents` must be exactly the events this same function has
 * previously returned as `"accepted"`, in order — the classification
 * relies on `acceptedEvents.length` being the next expected sequence
 * number and `acceptedEvents[sequence]` being the event stored at that
 * slot.
 */
export function parseAndClassifyIncomingEvent(
  raw: string,
  acceptedEvents: readonly NormalizedAgentEvent[],
  identity: EventIdentity,
): EventValidationOutcome {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "message was not valid JSON" };
  }

  let event: NormalizedAgentEvent;
  try {
    event = parseNormalizedAgentEvent(parsedJson);
  } catch (error) {
    const reason =
      error instanceof ProtocolValidationError
        ? "message did not match the normalized event schema"
        : "message could not be validated";
    return { kind: "invalid", reason };
  }

  if (event.taskId !== identity.taskId) {
    return { kind: "identity-mismatch", field: "taskId", event };
  }
  if (identity.runId !== null && event.runId !== identity.runId) {
    return { kind: "identity-mismatch", field: "runId", event };
  }
  if (identity.agentId !== null && event.agentId !== identity.agentId) {
    return { kind: "identity-mismatch", field: "agentId", event };
  }

  const nextExpectedSequence = acceptedEvents.length;
  if (event.sequence < nextExpectedSequence) {
    const existing = acceptedEvents[event.sequence];
    if (existing?.eventId === event.eventId) {
      return { kind: "duplicate", event };
    }
    return { kind: "conflict", event };
  }
  if (event.sequence > nextExpectedSequence) {
    return { kind: "gap", event };
  }
  return { kind: "accepted", event };
}
