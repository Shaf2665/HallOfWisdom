import {
  PROTOCOL_VERSION,
  parseApprovalRequiredEvent,
  parseFileChangedEvent,
  parseMessageDeltaEvent,
  parseRunCancelledEvent,
  parseRunCompletedEvent,
  parseRunFailedEvent,
  parseRunStartedEvent,
  parseToolCompletedEvent,
  parseToolStartedEvent,
  type ApprovalRequiredEvent,
  type ApprovalRiskLevel,
  type CancelledBy,
  type FileChangeOperation,
  type FileChangedEvent,
  type MessageDeltaEvent,
  type RunCancelledEvent,
  type RunCompletedEvent,
  type RunFailedEvent,
  type RunStartedEvent,
  type StructuredFailure,
  type ToolCompletedEvent,
  type ToolStartedEvent,
} from "@hall-of-wisdom/protocol";

export interface EventFactoryContext {
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
}

interface EventEnvelope {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly eventId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly timestamp: string;
  readonly sequence: number;
}

/**
 * Generates a cross-platform, sufficiently-unique event identifier.
 *
 * `crypto.randomUUID()` is used deliberately as a *global*, not via a
 * `node:crypto` import: `globalThis.crypto.randomUUID` is a Web Crypto API
 * function available natively, without any import, in both this SDK's
 * targeted Node runtime (Node >=24.11.0, where it has been stable and
 * unflagged since Node 19) and in every evergreen browser in a secure
 * context. Using the global keeps this file free of any `node:`-prefixed
 * import, which is what makes it safe to run unmodified in the browser.
 */
function generateEventId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Builds every normalized Hall event for one run, owning the shared
 * envelope fields (`protocolVersion`, `eventId`, `runId`, `taskId`,
 * `agentId`, `timestamp`, `sequence`) so adapters never hand-assemble an
 * envelope themselves. The sequence counter starts at 0, increments by
 * exactly 1 per event produced by this factory instance, and is never
 * shared across two different runs (one factory per run).
 *
 * Every method validates its own output through the protocol package's
 * `parse*` functions before returning it, so a bug in this factory fails
 * loudly here rather than producing a malformed event that only fails
 * validation somewhere downstream.
 */
export class EventFactory {
  #sequence = 0;
  readonly #context: EventFactoryContext;

  constructor(context: EventFactoryContext) {
    this.#context = context;
  }

  get nextSequence(): number {
    return this.#sequence;
  }

  private envelope(): EventEnvelope {
    const envelope: EventEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: generateEventId(),
      runId: this.#context.runId,
      taskId: this.#context.taskId,
      agentId: this.#context.agentId,
      timestamp: new Date().toISOString(),
      sequence: this.#sequence,
    };
    this.#sequence += 1;
    return envelope;
  }

  runStarted(): RunStartedEvent {
    return parseRunStartedEvent({ ...this.envelope(), type: "run.started", payload: {} });
  }

  messageDelta(text: string): MessageDeltaEvent {
    return parseMessageDeltaEvent({
      ...this.envelope(),
      type: "message.delta",
      payload: { text },
    });
  }

  toolStarted(toolCallId: string, toolName: string): ToolStartedEvent {
    return parseToolStartedEvent({
      ...this.envelope(),
      type: "tool.started",
      payload: { toolCallId, toolName },
    });
  }

  toolCompleted(
    toolCallId: string,
    toolName: string,
    success: boolean,
    output?: string,
  ): ToolCompletedEvent {
    return parseToolCompletedEvent({
      ...this.envelope(),
      type: "tool.completed",
      payload: { toolCallId, toolName, success, output },
    });
  }

  fileChanged(path: string, operation: FileChangeOperation): FileChangedEvent {
    return parseFileChangedEvent({
      ...this.envelope(),
      type: "file.changed",
      payload: { path, operation },
    });
  }

  approvalRequired(reason: string, riskLevel: ApprovalRiskLevel): ApprovalRequiredEvent {
    return parseApprovalRequiredEvent({
      ...this.envelope(),
      type: "approval.required",
      payload: { reason, riskLevel },
    });
  }

  runCompleted(summary?: string): RunCompletedEvent {
    return parseRunCompletedEvent({
      ...this.envelope(),
      type: "run.completed",
      payload: { summary },
    });
  }

  runFailed(failure: StructuredFailure): RunFailedEvent {
    return parseRunFailedEvent({
      ...this.envelope(),
      type: "run.failed",
      payload: { failure },
    });
  }

  runCancelled(cancelledBy: CancelledBy, reason?: string): RunCancelledEvent {
    return parseRunCancelledEvent({
      ...this.envelope(),
      type: "run.cancelled",
      payload: { cancelledBy, reason },
    });
  }
}
