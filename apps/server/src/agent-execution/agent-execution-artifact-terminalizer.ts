import { randomUUID } from "node:crypto";
import type { RunTaskResult } from "@hall-of-wisdom/hall-runner";
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
import {
  assertTerminalSnapshotMatchesRunResult,
  enrichTerminalSnapshotWithRunResult,
  type AgentExecutionTerminalSnapshot,
} from "./agent-execution-terminal-snapshot.js";

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
  readonly snapshot: AgentExecutionTerminalSnapshot;
  readonly runResult?: RunTaskResult | undefined;
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
    assertTerminalSnapshotMatchesRunResult(input.snapshot, input.runResult);
    const terminalInput =
      input.runResult === undefined
        ? input
        : {
            ...input,
            snapshot: enrichTerminalSnapshotWithRunResult(input.snapshot, input.runResult),
          };
    const existing = this.#store.findByHallAgentRunId(terminalInput.snapshot.hallAgentRunId);
    if (existing !== undefined) {
      const expected = createAgentExecutionArtifactRecord(
        buildArtifactInput({
          input: terminalInput,
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

    const evidence = await this.#collectEvidence(terminalInput);
    const existingAwareInput = buildArtifactInput({
      input: terminalInput,
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
      const raced = this.#store.findByHallAgentRunId(terminalInput.snapshot.hallAgentRunId);
      if (raced !== undefined && semanticallyEquivalent(raced, expected)) return raced;
      throw new AgentExecutionArtifactMismatchError();
    }
  }

  async #collectEvidence(
    input: TerminalizeAgentExecutionInput,
  ): Promise<GitArtifactEvidence | undefined> {
    if (input.snapshot.worktreeId === undefined) return undefined;
    if (this.#gitArtifactCollector === undefined) {
      throw new AgentExecutionArtifactTerminalizationError(
        "Worktree artifact evidence is required, but no Git collector is configured.",
      );
    }
    const evidence = await this.#gitArtifactCollector.collect(input.snapshot.worktreeId);
    if (evidence.worktreeId !== input.snapshot.worktreeId) {
      throw new AgentExecutionArtifactTerminalizationError(
        "Collected Git evidence did not match the expected worktree.",
      );
    }
    if (
      evidence.hallTaskId !== input.snapshot.hallTaskId ||
      evidence.hallAgentRunId !== input.snapshot.hallAgentRunId
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
  return {
    artifactId: options.artifactId,
    hallTaskId: input.snapshot.hallTaskId,
    hallAgentRunId: input.snapshot.hallAgentRunId,
    adapterId: input.snapshot.adapterId,
    ...(input.snapshot.worktreeId !== undefined ? { worktreeId: input.snapshot.worktreeId } : {}),
    outcome,
    ...terminalFailureFields(outcome, input),
    startedAt: input.snapshot.startedAt,
    finishedAt: input.snapshot.finishedAt,
    durationMs: durationMs(input.snapshot.startedAt, input.snapshot.finishedAt),
    ...(input.snapshot.exitCode !== undefined ? { exitCode: input.snapshot.exitCode } : {}),
    ...(evidence?.baseCommit !== undefined ? { baseCommit: evidence.baseCommit } : {}),
    ...(evidence?.finalCommit !== undefined ? { finalCommit: evidence.finalCommit } : {}),
    changedFiles: evidence?.changedFiles ?? [],
    diffSummary: evidence?.diffSummary ?? { filesChanged: 0, insertions: 0, deletions: 0 },
    ...finalSummaryFields(input.snapshot),
    createdAt: options.createdAt,
  };
}

function outcomeFromTerminal(input: TerminalizeAgentExecutionInput): AgentExecutionArtifactOutcome {
  switch (input.snapshot.terminalEvent.type) {
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
    const failure = input.snapshot.failure;
    return {
      terminalReasonCode: failure?.code ?? "TASK_EXECUTION_FAILED",
      safeTerminalSummary: failure?.message,
    };
  }
  const by = input.snapshot.cancellation?.cancelledBy.toUpperCase() ?? "SYSTEM";
  return {
    terminalReasonCode: `CANCELLED_BY_${by}`,
    safeTerminalSummary: input.snapshot.cancellation?.reason,
  };
}

function finalSummaryFields(snapshot: AgentExecutionTerminalSnapshot): {
  readonly finalSummary?: string | undefined;
} {
  if (snapshot.terminalEvent.type !== "run.completed" || snapshot.finalSummary === undefined) {
    return {};
  }
  return { finalSummary: snapshot.finalSummary };
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
