import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { SqliteComparisonStore } from "../comparisons/sqlite-comparison-store.js";
import { SqliteEventStore } from "../events/sqlite-event-store.js";
import type {
  AgentComparisonRecord,
  ComparisonCandidateRecord,
} from "../comparisons/comparison-record.js";
import {
  reconcileComparisons,
  RESTART_INTERRUPTED_CANDIDATE_RUN_CODE,
  RESTART_INTERRUPTED_PREPARATION_CODE,
} from "./reconcile-comparisons.js";

const openDatabases: HallDatabase[] = [];
afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

function openHarness(): { comparisonStore: SqliteComparisonStore; eventStore: SqliteEventStore } {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  openDatabases.push(db);
  return {
    comparisonStore: new SqliteComparisonStore({ db, maxComparisons: 100 }),
    eventStore: new SqliteEventStore({
      db,
      streamKind: "comparison_candidate",
      maxEventsPerStream: 50,
    }),
  };
}

const NOW = "2026-01-01T00:00:00.000Z";

function buildCandidate(
  candidateId: string,
  overrides: Partial<ComparisonCandidateRecord> = {},
): ComparisonCandidateRecord {
  return {
    candidateId,
    adapterId: overrides.adapterId ?? "hall.claude-code",
    displayName: overrides.displayName ?? "Claude Code",
    status: overrides.status ?? "pending",
    executionTrust: overrides.executionTrust,
    runId: overrides.runId,
    agentId: overrides.agentId,
    createdAt: NOW,
    preparedAt: overrides.preparedAt,
    startedAt: overrides.startedAt,
    completedAt: overrides.completedAt,
    eventCount: overrides.eventCount ?? 0,
    lastSequence: overrides.lastSequence,
    terminalEventType: overrides.terminalEventType,
    failure: overrides.failure,
    cancellationRequested: overrides.cancellationRequested ?? false,
    resultEvidence: overrides.resultEvidence,
    safeFailureReason: overrides.safeFailureReason,
  };
}

function buildComparison(
  comparisonId: string,
  overrides: Partial<AgentComparisonRecord> = {},
): AgentComparisonRecord {
  return {
    comparisonId,
    sourceTaskId: "task-1",
    title: "Compare",
    description: "",
    priority: "normal",
    requirements: undefined,
    baseCommit: overrides.baseCommit,
    status: overrides.status ?? "ready",
    createdAt: NOW,
    updatedAt: NOW,
    preparedAt: overrides.preparedAt,
    candidates: overrides.candidates ?? [
      buildCandidate(`${comparisonId}-a`),
      buildCandidate(`${comparisonId}-b`),
    ],
    cleanupStatus: overrides.cleanupStatus ?? "not_started",
    cleanupError: overrides.cleanupError,
    prepareFailureCode: overrides.prepareFailureCode,
    prepareFailureReason: overrides.prepareFailureReason,
    preference: overrides.preference,
  };
}

function makeEvent(
  candidateId: string,
  sequence: number,
  overrides: Partial<NormalizedAgentEvent> = {},
): NormalizedAgentEvent {
  return {
    protocolVersion: "0.1",
    eventId: `${candidateId}-event-${String(sequence)}`,
    runId: "run-1",
    taskId: candidateId,
    agentId: "agent-1",
    timestamp: NOW,
    sequence,
    type: "run.started",
    payload: {},
    ...overrides,
  } as NormalizedAgentEvent;
}

describe("reconcileComparisons", () => {
  it("leaves a comparison with no active candidate run untouched", () => {
    const { comparisonStore, eventStore } = openHarness();
    comparisonStore.add(buildComparison("cmp-1", { status: "ready" }));

    const summary = reconcileComparisons(comparisonStore, eventStore);

    expect(summary.comparisonsScanned).toBe(1);
    expect(summary.interruptedCandidateRunsMarkedFailed).toEqual([]);
    expect(comparisonStore.get("cmp-1").status).toBe("ready");
  });

  it("replays a terminal event whose candidate status-side effects never committed", () => {
    const { comparisonStore, eventStore } = openHarness();
    comparisonStore.add(
      buildComparison("cmp-1", {
        status: "running",
        candidates: [
          buildCandidate("cmp-1-a", { status: "running", runId: "run-1", agentId: "agent-1" }),
          buildCandidate("cmp-1-b", { status: "prepared" }),
        ],
      }),
    );
    eventStore.append("cmp-1-a", makeEvent("cmp-1-a", 0, { type: "run.completed", payload: {} }), {
      runId: "run-1",
      taskId: "cmp-1-a",
      agentId: "agent-1",
    });

    const summary = reconcileComparisons(comparisonStore, eventStore);

    expect(summary.terminalOutcomesReplayed).toBe(1);
    expect(summary.interruptedCandidateRunsMarkedFailed).toEqual([]);
    const record = comparisonStore.get("cmp-1");
    const candidateA = record.candidates.find((c) => c.candidateId === "cmp-1-a");
    expect(candidateA?.status).toBe("completed");
    expect(candidateA?.eventCount).toBe(1);
  });

  it("marks a genuinely interrupted candidate run failed exactly once across repeated passes", () => {
    const { comparisonStore, eventStore } = openHarness();
    comparisonStore.add(
      buildComparison("cmp-1", {
        status: "running",
        candidates: [
          buildCandidate("cmp-1-a", { status: "running", runId: "run-1", agentId: "agent-1" }),
          buildCandidate("cmp-1-b", { status: "prepared" }),
        ],
      }),
    );
    eventStore.append("cmp-1-a", makeEvent("cmp-1-a", 0, { type: "run.started" }), {
      runId: "run-1",
      taskId: "cmp-1-a",
      agentId: "agent-1",
    });

    const firstPass = reconcileComparisons(comparisonStore, eventStore);
    expect(firstPass.interruptedCandidateRunsMarkedFailed).toEqual(["cmp-1-a"]);

    const afterFirst = comparisonStore.get("cmp-1");
    const candidateA = afterFirst.candidates.find((c) => c.candidateId === "cmp-1-a");
    expect(candidateA?.status).toBe("failed");
    expect(candidateA?.failure?.code).toBe(RESTART_INTERRUPTED_CANDIDATE_RUN_CODE);

    const secondPass = reconcileComparisons(comparisonStore, eventStore);
    expect(secondPass.interruptedCandidateRunsMarkedFailed).toEqual([]);
    expect(eventStore.list("cmp-1-a")).toHaveLength(2);
  });

  it("marks a comparison stuck in 'preparing' as failed (interrupted preparation), idempotently", () => {
    const { comparisonStore, eventStore } = openHarness();
    comparisonStore.add(buildComparison("cmp-1", { status: "preparing" }));

    const firstPass = reconcileComparisons(comparisonStore, eventStore);
    expect(firstPass.interruptedPreparationsMarkedFailed).toEqual(["cmp-1"]);
    const record = comparisonStore.get("cmp-1");
    expect(record.status).toBe("failed");
    expect(record.prepareFailureCode).toBe(RESTART_INTERRUPTED_PREPARATION_CODE);

    const secondPass = reconcileComparisons(comparisonStore, eventStore);
    expect(secondPass.interruptedPreparationsMarkedFailed).toEqual([]);
  });

  it("marks an interrupted in-progress cleanup as failed, idempotently across repeated passes", () => {
    const { comparisonStore, eventStore } = openHarness();
    comparisonStore.add(buildComparison("cmp-1", { status: "ready" }));
    comparisonStore.claimCleanup("cmp-1");
    comparisonStore.markCleaning("cmp-1");

    const firstPass = reconcileComparisons(comparisonStore, eventStore);
    expect(firstPass.interruptedCleanupsMarkedFailed).toEqual(["cmp-1"]);
    const record = comparisonStore.get("cmp-1");
    expect(record.cleanupStatus).toBe("failed");
    expect(record.status).toBe("cleaning");

    const secondPass = reconcileComparisons(comparisonStore, eventStore);
    expect(secondPass.interruptedCleanupsMarkedFailed).toEqual([]);
  });

  it("leaves a reconciled interrupted cleanup in a state a fresh DELETE retry can re-claim", () => {
    const { comparisonStore, eventStore } = openHarness();
    comparisonStore.add(buildComparison("cmp-1", { status: "ready" }));
    comparisonStore.claimCleanup("cmp-1");
    comparisonStore.markCleaning("cmp-1");
    reconcileComparisons(comparisonStore, eventStore);

    expect(() => comparisonStore.claimCleanup("cmp-1")).not.toThrow();
  });
});
