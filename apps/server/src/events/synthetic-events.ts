import {
  PROTOCOL_VERSION,
  parseRunCancelledEvent,
  parseRunFailedEvent,
  type CancelledBy,
  type RunCancelledEvent,
  type RunFailedEvent,
} from "@hall-of-wisdom/protocol";

export interface SyntheticFailureEventInput {
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly sequence: number;
  readonly code: string;
  readonly message: string;
}

export interface SyntheticCancellationEventInput {
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly sequence: number;
  readonly cancelledBy: CancelledBy;
  readonly reason?: string | undefined;
}

/**
 * Builds a Hall-Core-originated `run.failed` event for infrastructure
 * failures the agent adapter itself never reported (event-capacity
 * exhaustion, an `EventStore` invariant violation, an unexpected
 * `runTask()` rejection). Validated through the same `parseRunFailedEvent`
 * gate every adapter-produced event passes, so it is indistinguishable in
 * shape from a real adapter event to any consumer (REST response,
 * WebSocket client) — see `docs/architecture/0004-hall-core-server.md`,
 * "Event-capacity terminal handling", for why the caller (not this
 * function) is responsible for keeping `message` free of any raw
 * exception text, stack trace, or filesystem path.
 */
export function buildInfrastructureFailureEvent(input: SyntheticFailureEventInput): RunFailedEvent {
  return parseRunFailedEvent({
    protocolVersion: PROTOCOL_VERSION,
    eventId: globalThis.crypto.randomUUID(),
    runId: input.runId,
    taskId: input.taskId,
    agentId: input.agentId,
    timestamp: new Date().toISOString(),
    sequence: input.sequence,
    type: "run.failed",
    payload: {
      failure: {
        code: input.code,
        message: input.message,
        retryable: false,
      },
    },
  });
}

export function buildInfrastructureCancellationEvent(
  input: SyntheticCancellationEventInput,
): RunCancelledEvent {
  return parseRunCancelledEvent({
    protocolVersion: PROTOCOL_VERSION,
    eventId: globalThis.crypto.randomUUID(),
    runId: input.runId,
    taskId: input.taskId,
    agentId: input.agentId,
    timestamp: new Date().toISOString(),
    sequence: input.sequence,
    type: "run.cancelled",
    payload: {
      cancelledBy: input.cancelledBy,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
  });
}
