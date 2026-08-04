import type { RunTaskResult, TerminalEventType } from "@hall-of-wisdom/hall-runner";
import type { NormalizedAgentEvent, StructuredFailure } from "@hall-of-wisdom/protocol";
import type { TaskRecord } from "../tasks/task-record.js";
import { AgentExecutionArtifactTerminalizationError } from "./agent-execution-errors.js";

export interface AgentExecutionTerminalEventIdentity {
  readonly eventId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: TerminalEventType;
}

export interface AgentExecutionTerminalSnapshot {
  readonly hallTaskId: string;
  readonly hallAgentRunId: string;
  readonly adapterId: string;
  readonly agentId: string;
  readonly terminalEvent: AgentExecutionTerminalEventIdentity;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly failure: StructuredFailure | undefined;
  readonly cancellation:
    | { readonly cancelledBy: "user" | "orchestrator" | "system"; readonly reason?: string }
    | undefined;
  readonly finalSummary: string | undefined;
  readonly exitCode: number | undefined;
  readonly worktreeId: string | undefined;
}

export interface BuildTerminalSnapshotInput {
  readonly preTerminalRecord: TaskRecord;
  readonly adapterId: string;
  readonly event: NormalizedAgentEvent;
  readonly worktreeId?: string | undefined;
  readonly runResult?: RunTaskResult | undefined;
}

export function buildAgentExecutionTerminalSnapshot(
  input: BuildTerminalSnapshotInput,
): AgentExecutionTerminalSnapshot {
  const { preTerminalRecord, event } = input;
  if (!isTerminalEvent(event)) {
    throw new AgentExecutionArtifactTerminalizationError(
      "Terminal snapshot requires a terminal event.",
    );
  }
  if (preTerminalRecord.runId !== event.runId) {
    throw new AgentExecutionArtifactTerminalizationError(
      "Terminal event run identity does not match the committed task run.",
    );
  }
  if (preTerminalRecord.adapterId !== input.adapterId) {
    throw new AgentExecutionArtifactTerminalizationError(
      "Terminal snapshot adapter identity does not match the committed task assignment.",
    );
  }
  if (preTerminalRecord.agentId !== event.agentId) {
    throw new AgentExecutionArtifactTerminalizationError(
      "Terminal event agent identity does not match the committed task assignment.",
    );
  }
  if (preTerminalRecord.task.taskId !== event.taskId) {
    throw new AgentExecutionArtifactTerminalizationError(
      "Terminal event task identity does not match the committed task.",
    );
  }
  validateRunResultIdentity(input.runResult, input);

  return {
    hallTaskId: event.taskId,
    hallAgentRunId: event.runId,
    adapterId: input.adapterId,
    agentId: event.agentId,
    terminalEvent: {
      eventId: event.eventId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      type: event.type,
    },
    startedAt: preTerminalRecord.startedAt ?? event.timestamp,
    finishedAt: event.timestamp,
    failure: event.type === "run.failed" ? event.payload.failure : undefined,
    cancellation:
      event.type === "run.cancelled"
        ? {
            cancelledBy: event.payload.cancelledBy,
            ...(event.payload.reason !== undefined ? { reason: event.payload.reason } : {}),
          }
        : undefined,
    finalSummary: event.type === "run.completed" ? event.payload.summary : undefined,
    exitCode: input.runResult?.exitCode,
    worktreeId: input.worktreeId,
  };
}

export function assertTerminalSnapshotMatchesEvent(
  snapshot: AgentExecutionTerminalSnapshot,
  event: NormalizedAgentEvent | undefined,
): void {
  if (event === undefined) return;
  if (!isTerminalEvent(event)) {
    throw new AgentExecutionArtifactTerminalizationError(
      "Terminal snapshot was compared with a non-terminal event.",
    );
  }
  if (
    snapshot.terminalEvent.eventId !== event.eventId ||
    snapshot.terminalEvent.sequence !== event.sequence ||
    snapshot.terminalEvent.timestamp !== event.timestamp ||
    snapshot.terminalEvent.type !== event.type ||
    snapshot.hallAgentRunId !== event.runId ||
    snapshot.hallTaskId !== event.taskId ||
    snapshot.agentId !== event.agentId
  ) {
    throw new AgentExecutionArtifactTerminalizationError(
      "Terminal event identity does not match the committed terminal snapshot.",
    );
  }
}

export function assertTerminalSnapshotMatchesRunResult(
  snapshot: AgentExecutionTerminalSnapshot,
  runResult: RunTaskResult | undefined,
): void {
  if (runResult === undefined) return;
  if (
    snapshot.hallAgentRunId !== runResult.runId ||
    snapshot.hallTaskId !== runResult.taskId ||
    snapshot.agentId !== runResult.agentId ||
    snapshot.terminalEvent.type !== runResult.terminalEventType
  ) {
    throw new AgentExecutionArtifactTerminalizationError(
      "Run result identity does not match the committed terminal snapshot.",
    );
  }
}

export function enrichTerminalSnapshotWithRunResult(
  snapshot: AgentExecutionTerminalSnapshot,
  runResult: RunTaskResult,
): AgentExecutionTerminalSnapshot {
  assertTerminalSnapshotMatchesRunResult(snapshot, runResult);
  return { ...snapshot, exitCode: runResult.exitCode };
}

function validateRunResultIdentity(
  runResult: RunTaskResult | undefined,
  input: BuildTerminalSnapshotInput,
): void {
  if (runResult === undefined) return;
  if (
    runResult.runId !== input.event.runId ||
    runResult.taskId !== input.event.taskId ||
    runResult.agentId !== input.event.agentId ||
    runResult.terminalEventType !== input.event.type
  ) {
    throw new AgentExecutionArtifactTerminalizationError(
      "Run result identity does not match the terminal event.",
    );
  }
}

function isTerminalEvent(event: NormalizedAgentEvent): event is NormalizedAgentEvent & {
  readonly type: TerminalEventType;
} {
  return (
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}
