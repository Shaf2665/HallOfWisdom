import { randomUUID } from "node:crypto";
import type { RunTaskResult } from "@hall-of-wisdom/hall-runner";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import type { TaskRecord } from "../tasks/task-record.js";
import {
  AgentExecutionArtifactConflictError,
  AgentExecutionArtifactError,
} from "../execution-artifacts/agent-execution-artifact-errors.js";
import {
  createAgentExecutionArtifactRecord,
  type AgentExecutionArtifactOutcome,
  type AgentExecutionArtifactRecord,
  type CreateAgentExecutionArtifactInput,
} from "../execution-artifacts/agent-execution-artifact-record.js";
import type { AgentExecutionArtifactStorePort } from "../execution-artifacts/agent-execution-artifact-store-port.js";
import type { GitArtifactEvidence } from "./git-artifact-collector.js";
import {
  AgentExecutionArtifactMismatchError,
  AgentExecutionArtifactTerminalizationError,
} from "./agent-execution-errors.js";

export interface AgentExecutionArtifactTerminalizerOptions {
  readonly store: AgentExecutionArtifactStorePort;
  readonly gitArtifactCollector?: GitArtifactEvidenceCollector | undefined;
  readonly now?: (() => string) | undefined;
  readonly artifactIdFactory?: (() => string) | undefined;
}

export interface GitArtifactEvidenceCollector {
  collect(worktreeId: string, signal?: AbortSignal): Promise<GitArtifactEvidence>;
}

export interface TerminalizeAgentExecutionInput {
  readonly taskRecord: TaskRecord;
  readonly adapterId: string;
  readonly runId: string;
  readonly worktreeId?: string | undefined;
  readonly terminalEvent?: NormalizedAgentEvent | undefined;
  readonly runResult?: RunTaskResult | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class AgentExecutionArtifactTerminalizer {
  readonly #store: AgentExecutionArtifactStorePort;
  readonly #gitArtifactCollector: GitArtifactEvidenceCollector | undefined;
  readonly #now: () => string;
  readonly #artifactIdFactory: () => string;

  constructor(options: AgentExecutionArtifactTerminalizerOptions) {
    this.#store = options.store;
    this.#gitArtifactCollector = options.gitArtifactCollector;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#artifactIdFactory = options.artifactIdFactory ?? (() => `artifact-${randomUUID()}`);
  }

  async terminalize(input: TerminalizeAgentExecutionInput): Promise<AgentExecutionArtifactRecord> {
    const existing = this.#store.findByHallAgentRunId(input.runId);
    if (existing !== undefined) {
      const expected = createAgentExecutionArtifactRecord(
        buildArtifactInput({
          input,
          evidence: evidenceFromExisting(existing),
          artifactId: existing.artifactId,
          createdAt: existing.createdAt,
        }),
      );
      if (!semanticallyEquivalent(existing, expected)) {
        throw new AgentExecutionArtifactMismatchError();
      }
      return existing;
    }

    const evidence = await this.#collectEvidence(input);
    const existingAwareInput = buildArtifactInput({
      input,
      evidence,
      artifactId: this.#artifactIdFactory(),
      createdAt: this.#now(),
    });
    const expected = createAgentExecutionArtifactRecord(existingAwareInput);

    try {
      return this.#store.create(existingAwareInput);
    } catch (error) {
      if (!(error instanceof AgentExecutionArtifactConflictError)) {
        throw toTerminalizationError(error);
      }
      const raced = this.#store.findByHallAgentRunId(input.runId);
      if (raced !== undefined && semanticallyEquivalent(raced, expected)) return raced;
      throw new AgentExecutionArtifactMismatchError();
    }
  }

  async #collectEvidence(
    input: TerminalizeAgentExecutionInput,
  ): Promise<GitArtifactEvidence | undefined> {
    if (input.worktreeId === undefined) return undefined;
    if (this.#gitArtifactCollector === undefined) {
      throw new AgentExecutionArtifactTerminalizationError(
        "Worktree artifact evidence is required, but no Git collector is configured.",
      );
    }
    const evidence = await this.#gitArtifactCollector.collect(input.worktreeId, input.signal);
    if (evidence.worktreeId !== input.worktreeId) {
      throw new AgentExecutionArtifactTerminalizationError(
        "Collected Git evidence did not match the expected worktree.",
      );
    }
    if (
      evidence.hallTaskId !== input.taskRecord.task.taskId ||
      evidence.hallAgentRunId !== input.runId
    ) {
      throw new AgentExecutionArtifactTerminalizationError(
        "Collected Git evidence did not match the authoritative task run.",
      );
    }
    return evidence;
  }
}

function evidenceFromExisting(
  record: AgentExecutionArtifactRecord,
): GitArtifactEvidence | undefined {
  if (record.worktreeId === undefined) return undefined;
  if (record.baseCommit === undefined || record.finalCommit === undefined) return undefined;
  return {
    worktreeId: record.worktreeId,
    hallTaskId: record.hallTaskId,
    hallAgentRunId: record.hallAgentRunId,
    baseCommit: record.baseCommit,
    finalCommit: record.finalCommit,
    changedFiles: record.changedFiles,
    diffSummary: record.diffSummary,
  };
}

function buildArtifactInput(options: {
  readonly input: TerminalizeAgentExecutionInput;
  readonly evidence: GitArtifactEvidence | undefined;
  readonly artifactId: string;
  readonly createdAt: string;
}): CreateAgentExecutionArtifactInput {
  const { input, evidence } = options;
  const outcome = outcomeFromTerminal(input);
  const finishedAt = input.taskRecord.completedAt ?? input.terminalEvent?.timestamp;
  if (finishedAt === undefined) {
    throw new AgentExecutionArtifactTerminalizationError(
      "Task has no authoritative terminal timestamp.",
    );
  }
  const startedAt = input.taskRecord.startedAt ?? finishedAt;
  return {
    artifactId: options.artifactId,
    hallTaskId: input.taskRecord.task.taskId,
    hallAgentRunId: input.runId,
    adapterId: input.adapterId,
    ...(input.worktreeId !== undefined ? { worktreeId: input.worktreeId } : {}),
    outcome,
    ...terminalFailureFields(outcome, input),
    startedAt,
    finishedAt,
    durationMs: durationMs(startedAt, finishedAt),
    ...(input.runResult?.exitCode !== undefined ? { exitCode: input.runResult.exitCode } : {}),
    ...(evidence?.baseCommit !== undefined ? { baseCommit: evidence.baseCommit } : {}),
    ...(evidence?.finalCommit !== undefined ? { finalCommit: evidence.finalCommit } : {}),
    changedFiles: evidence?.changedFiles ?? [],
    diffSummary: evidence?.diffSummary ?? { filesChanged: 0, insertions: 0, deletions: 0 },
    ...finalSummaryFields(input.terminalEvent),
    createdAt: options.createdAt,
  };
}

function outcomeFromTerminal(input: TerminalizeAgentExecutionInput): AgentExecutionArtifactOutcome {
  const type = input.taskRecord.terminalEventType ?? input.terminalEvent?.type;
  switch (type) {
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
    default:
      throw new AgentExecutionArtifactTerminalizationError(
        "Task has no supported authoritative terminal outcome.",
      );
  }
}

function terminalFailureFields(
  outcome: AgentExecutionArtifactOutcome,
  input: TerminalizeAgentExecutionInput,
): {
  readonly terminalReasonCode?: string | undefined;
  readonly safeTerminalSummary?: string | undefined;
} {
  if (outcome === "completed") return {};
  if (outcome === "failed") {
    return {
      terminalReasonCode: input.taskRecord.failure?.code ?? "TASK_EXECUTION_FAILED",
      safeTerminalSummary: input.taskRecord.failure?.message,
    };
  }
  const cancelled = input.terminalEvent?.type === "run.cancelled" ? input.terminalEvent : undefined;
  const by = cancelled?.payload.cancelledBy.toUpperCase() ?? "SYSTEM";
  return {
    terminalReasonCode: `CANCELLED_BY_${by}`,
    safeTerminalSummary: cancelled?.payload.reason,
  };
}

function finalSummaryFields(event: NormalizedAgentEvent | undefined): {
  readonly finalSummary?: string | undefined;
} {
  if (event?.type !== "run.completed" || event.payload.summary === undefined) return {};
  return { finalSummary: event.payload.summary };
}

function durationMs(startedAt: string, finishedAt: string): number {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    throw new AgentExecutionArtifactTerminalizationError("Task terminal timestamps are invalid.");
  }
  return finished - started;
}

function semanticallyEquivalent(
  existing: AgentExecutionArtifactRecord,
  expected: AgentExecutionArtifactRecord,
): boolean {
  return JSON.stringify(stripIdentity(existing)) === JSON.stringify(stripIdentity(expected));
}

function stripIdentity(
  record: AgentExecutionArtifactRecord,
): Omit<AgentExecutionArtifactRecord, "artifactId" | "createdAt"> {
  const { artifactId: _artifactId, createdAt: _createdAt, ...semantic } = record;
  return semantic;
}

function toTerminalizationError(error: unknown): AgentExecutionArtifactTerminalizationError {
  if (error instanceof AgentExecutionArtifactTerminalizationError) return error;
  if (error instanceof AgentExecutionArtifactError) {
    return new AgentExecutionArtifactTerminalizationError(error.message);
  }
  return new AgentExecutionArtifactTerminalizationError();
}
