import { describe, expect, it } from "vitest";
import { ComparisonStore } from "./comparison-store.js";
import {
  ComparisonCandidateNotFoundError,
  ComparisonCapacityReachedError,
  ComparisonNotFoundError,
  ComparisonStateConflictError,
  DuplicateComparisonError,
} from "../errors/app-error.js";
import type { AgentComparisonRecord, ComparisonCandidateRecord } from "./comparison-record.js";

function buildCandidate(
  overrides: Partial<ComparisonCandidateRecord> = {},
): ComparisonCandidateRecord {
  return {
    candidateId: overrides.candidateId ?? "candidate-a",
    adapterId: overrides.adapterId ?? "hall.claude-code",
    displayName: overrides.displayName ?? "Claude Code",
    status: overrides.status ?? "pending",
    executionTrust: overrides.executionTrust,
    runId: overrides.runId,
    agentId: overrides.agentId,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
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

function buildRecord(overrides: Partial<AgentComparisonRecord> = {}): AgentComparisonRecord {
  return {
    comparisonId: overrides.comparisonId ?? "comparison-1",
    sourceTaskId: overrides.sourceTaskId ?? "task-1",
    title: overrides.title ?? "Compare agents",
    description: overrides.description ?? "",
    priority: overrides.priority ?? "normal",
    requirements: overrides.requirements,
    baseCommit: overrides.baseCommit,
    status: overrides.status ?? "draft",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    preparedAt: overrides.preparedAt,
    candidates: overrides.candidates ?? [
      buildCandidate({ candidateId: "candidate-a", adapterId: "hall.claude-code" }),
      buildCandidate({ candidateId: "candidate-b", adapterId: "hall.codex" }),
    ],
    cleanupStatus: overrides.cleanupStatus ?? "not_started",
    cleanupError: overrides.cleanupError,
    prepareFailureCode: overrides.prepareFailureCode,
    prepareFailureReason: overrides.prepareFailureReason,
    preference: overrides.preference,
  };
}

describe("ComparisonStore", () => {
  it("adds and retrieves a comparison as a structuredClone (not a live reference)", () => {
    const store = new ComparisonStore({ maxComparisons: 10 });
    const record = buildRecord();
    store.add(record);

    const fetched = store.get("comparison-1");
    expect(fetched).toEqual(record);
    fetched.status = "preparing";
    expect(store.get("comparison-1").status).toBe("draft");
  });

  it("rejects adding a duplicate comparisonId", () => {
    const store = new ComparisonStore({ maxComparisons: 10 });
    store.add(buildRecord());
    expect(() => {
      store.add(buildRecord());
    }).toThrow(DuplicateComparisonError);
  });

  it("rejects adding beyond configured capacity", () => {
    const store = new ComparisonStore({ maxComparisons: 1 });
    store.add(buildRecord({ comparisonId: "a" }));
    expect(() => {
      store.add(buildRecord({ comparisonId: "b" }));
    }).toThrow(ComparisonCapacityReachedError);
  });

  it("throws ComparisonNotFoundError for an unknown comparisonId", () => {
    const store = new ComparisonStore({ maxComparisons: 10 });
    expect(() => store.get("missing")).toThrow(ComparisonNotFoundError);
    expect(() => store.getRevision("missing")).toThrow(ComparisonNotFoundError);
  });

  it("list() returns every comparison in insertion order, each a structuredClone", () => {
    const store = new ComparisonStore({ maxComparisons: 10 });
    store.add(buildRecord({ comparisonId: "a" }));
    store.add(buildRecord({ comparisonId: "b" }));
    expect(store.list().map((r) => r.comparisonId)).toEqual(["a", "b"]);
  });

  it("revision starts at 0 and increments by exactly 1 per successful mutation, never on a rejected one", () => {
    const store = new ComparisonStore({ maxComparisons: 10 });
    store.add(buildRecord());
    expect(store.getRevision("comparison-1")).toBe(0);

    store.claimPreparing("comparison-1");
    expect(store.getRevision("comparison-1")).toBe(1);

    expect(() => store.claimPreparing("comparison-1")).toThrow(ComparisonStateConflictError);
    expect(store.getRevision("comparison-1")).toBe(1);
  });

  describe("claimPreparing / setReady / setPrepareFailed", () => {
    it("claimPreparing rejects a second concurrent claim", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimPreparing("comparison-1");
      expect(() => store.claimPreparing("comparison-1")).toThrow(ComparisonStateConflictError);
    });

    it("setReady sets baseCommit, moves both candidates to prepared, and marks the comparison ready", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimPreparing("comparison-1");

      const record = store.setReady("comparison-1", {
        baseCommit: "a".repeat(40),
        candidates: [
          { candidateId: "candidate-a", executionTrust: "isolated" },
          { candidateId: "candidate-b", executionTrust: "trusted_local" },
        ],
      });

      expect(record.status).toBe("ready");
      expect(record.baseCommit).toBe("a".repeat(40));
      expect(record.candidates[0].status).toBe("prepared");
      expect(record.candidates[0].executionTrust).toBe("isolated");
      expect(record.candidates[1].status).toBe("prepared");
      expect(record.preparedAt).toBeDefined();
    });

    it("setReady rejects when the comparison is not currently preparing", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      expect(() =>
        store.setReady("comparison-1", { baseCommit: "a".repeat(40), candidates: [] }),
      ).toThrow(ComparisonStateConflictError);
    });

    it("setPrepareFailed moves the comparison to failed, leaves candidates pending, and annotates the identified candidate", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimPreparing("comparison-1");

      const record = store.setPrepareFailed(
        "comparison-1",
        "candidate-b",
        "COMPARISON_PREPARE_FAILED",
        "worktree creation failed",
      );

      expect(record.status).toBe("failed");
      expect(record.candidates[0].status).toBe("pending");
      expect(record.candidates[1].status).toBe("pending");
      expect(record.candidates[1].safeFailureReason).toBe("worktree creation failed");
      expect(record.candidates[0].safeFailureReason).toBeUndefined();
      expect(record.prepareFailureCode).toBe("COMPARISON_PREPARE_FAILED");
      expect(record.prepareFailureReason).toBe("worktree creation failed");
    });

    it("setPrepareFailed records the code/reason at the comparison level even with no identified candidate", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimPreparing("comparison-1");

      const record = store.setPrepareFailed(
        "comparison-1",
        undefined,
        "COMPARISON_SOURCE_REPOSITORY_DIRTY",
        "The source repository has uncommitted changes.",
      );

      expect(record.status).toBe("failed");
      expect(record.prepareFailureCode).toBe("COMPARISON_SOURCE_REPOSITORY_DIRTY");
      expect(record.prepareFailureReason).toBe("The source repository has uncommitted changes.");
      expect(record.candidates[0].safeFailureReason).toBeUndefined();
      expect(record.candidates[1].safeFailureReason).toBeUndefined();
    });
  });

  describe("claimCandidateStart / clearCandidateStart", () => {
    function buildReadyStore(): ComparisonStore {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimPreparing("comparison-1");
      store.setReady("comparison-1", {
        baseCommit: "a".repeat(40),
        candidates: [
          { candidateId: "candidate-a", executionTrust: "isolated" },
          { candidateId: "candidate-b", executionTrust: "trusted_local" },
        ],
      });
      return store;
    }

    it("claims a candidate start, allocating a runId and moving the comparison to running", () => {
      const store = buildReadyStore();
      const record = store.claimCandidateStart("comparison-1", "candidate-a", "run-1", "agent-a");
      expect(record.status).toBe("running");
      expect(record.candidates[0].status).toBe("running");
      expect(record.candidates[0].runId).toBe("run-1");
      expect(record.candidates[1].status).toBe("prepared");
    });

    it("rejects starting a second candidate while the first is still running — comparisons run candidates sequentially, one at a time", () => {
      const store = buildReadyStore();
      store.claimCandidateStart("comparison-1", "candidate-a", "run-1", "agent-a");
      expect(() =>
        store.claimCandidateStart("comparison-1", "candidate-b", "run-2", "agent-b"),
      ).toThrow(ComparisonStateConflictError);
    });

    it("allows starting the second candidate once the first has reached a terminal status", () => {
      const store = buildReadyStore();
      store.claimCandidateStart("comparison-1", "candidate-a", "run-1", "agent-a");
      store.setCandidateCompleted("comparison-1", "candidate-a", {
        completedAt: "2026-01-01T01:00:00.000Z",
        terminalEventType: "run.completed",
      });
      const record = store.claimCandidateStart("comparison-1", "candidate-b", "run-2", "agent-b");
      expect(record.candidates[1].status).toBe("running");
    });

    it("rejects a second concurrent claim for the same candidate", () => {
      const store = buildReadyStore();
      store.claimCandidateStart("comparison-1", "candidate-a", "run-1", "agent-a");
      expect(() =>
        store.claimCandidateStart("comparison-1", "candidate-a", "run-2", "agent-a"),
      ).toThrow(ComparisonStateConflictError);
    });

    it("rejects starting a candidate that does not exist", () => {
      const store = buildReadyStore();
      expect(() =>
        store.claimCandidateStart("comparison-1", "missing", "run-1", "agent-a"),
      ).toThrow(ComparisonCandidateNotFoundError);
    });

    it("clearCandidateStart rolls the candidate back to prepared and the comparison back to ready when nothing else has started", () => {
      const store = buildReadyStore();
      store.claimCandidateStart("comparison-1", "candidate-a", "run-1", "agent-a");
      store.clearCandidateStart("comparison-1", "candidate-a");

      const record = store.get("comparison-1");
      expect(record.candidates[0].status).toBe("prepared");
      expect(record.candidates[0].runId).toBeUndefined();
      expect(record.status).toBe("ready");
    });

    it("clearCandidateStart keeps the comparison running if the other candidate has already made progress", () => {
      const store = buildReadyStore();
      store.claimCandidateStart("comparison-1", "candidate-a", "run-1", "agent-a");
      // Candidates start sequentially — "candidate-b" cannot be claimed
      // while "candidate-a" is running, so its progress is simulated
      // directly (this test targets `clearCandidateStart`'s status
      // re-derivation, not the sequential-start rule itself, which has
      // its own dedicated tests below).
      store.setCandidateCompleted("comparison-1", "candidate-b", {
        completedAt: "2026-01-01T00:30:00.000Z",
        terminalEventType: "run.completed",
      });
      store.clearCandidateStart("comparison-1", "candidate-a");

      expect(store.get("comparison-1").status).toBe("running");
    });
  });

  describe("setCandidateCompleted — comparison-level rollup", () => {
    function buildRunningStore(): ComparisonStore {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimPreparing("comparison-1");
      store.setReady("comparison-1", {
        baseCommit: "a".repeat(40),
        candidates: [
          { candidateId: "candidate-a", executionTrust: "isolated" },
          { candidateId: "candidate-b", executionTrust: "trusted_local" },
        ],
      });
      // Only "candidate-a" is claimed running here — candidates start
      // sequentially (see the dedicated tests above), so any test below
      // that needs "candidate-b" to have made progress too completes it
      // directly rather than claiming a second concurrent start.
      store.claimCandidateStart("comparison-1", "candidate-a", "run-1", "agent-a");
      return store;
    }

    it("stays running while only one candidate has completed", () => {
      const store = buildRunningStore();
      const record = store.setCandidateCompleted("comparison-1", "candidate-a", {
        completedAt: "2026-01-01T01:00:00.000Z",
        terminalEventType: "run.completed",
      });
      expect(record.candidates[0].status).toBe("completed");
      expect(record.status).toBe("running");
    });

    it("moves to completed once both candidates complete successfully", () => {
      const store = buildRunningStore();
      store.setCandidateCompleted("comparison-1", "candidate-a", {
        completedAt: "2026-01-01T01:00:00.000Z",
        terminalEventType: "run.completed",
      });
      const record = store.setCandidateCompleted("comparison-1", "candidate-b", {
        completedAt: "2026-01-01T01:00:01.000Z",
        terminalEventType: "run.completed",
      });
      expect(record.status).toBe("completed");
    });

    it("moves to partially_completed when both are terminal but not all completed", () => {
      const store = buildRunningStore();
      store.setCandidateCompleted("comparison-1", "candidate-a", {
        completedAt: "2026-01-01T01:00:00.000Z",
        terminalEventType: "run.completed",
      });
      const record = store.setCandidateCompleted("comparison-1", "candidate-b", {
        completedAt: "2026-01-01T01:00:01.000Z",
        terminalEventType: "run.failed",
        failure: { code: "TEST_FAILURE", message: "boom", retryable: false },
      });
      expect(record.status).toBe("partially_completed");
      expect(record.candidates[1].failure?.code).toBe("TEST_FAILURE");
    });

    it("does not resurrect an outcome status once cleanup has begun (late-arriving terminal event after cleaning starts)", () => {
      const store = buildRunningStore();
      store.setCandidateCompleted("comparison-1", "candidate-a", {
        completedAt: "2026-01-01T01:00:00.000Z",
        terminalEventType: "run.completed",
      });
      // Cleanup begins while candidate-b is still "running".
      store.claimCleanup("comparison-1");
      store.markCleaning("comparison-1");
      expect(store.get("comparison-1").status).toBe("cleaning");

      // A late run.cancelled for candidate-b arrives after the abort signal.
      const record = store.setCandidateCompleted("comparison-1", "candidate-b", {
        completedAt: "2026-01-01T01:00:05.000Z",
        terminalEventType: "run.cancelled",
      });
      expect(record.candidates[1].status).toBe("cancelled");
      expect(record.status).toBe("cleaning");
    });
  });

  describe("cancellation", () => {
    it("setCandidateCancellationRequested is idempotent and rejects a non-running candidate", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimPreparing("comparison-1");
      store.setReady("comparison-1", {
        baseCommit: "a".repeat(40),
        candidates: [
          { candidateId: "candidate-a", executionTrust: "isolated" },
          { candidateId: "candidate-b", executionTrust: "trusted_local" },
        ],
      });
      expect(() => store.setCandidateCancellationRequested("comparison-1", "candidate-a")).toThrow(
        ComparisonStateConflictError,
      );

      store.claimCandidateStart("comparison-1", "candidate-a", "run-1", "agent-a");
      expect(store.setCandidateCancellationRequested("comparison-1", "candidate-a")).toEqual({
        alreadyRequested: false,
      });
      expect(store.setCandidateCancellationRequested("comparison-1", "candidate-a")).toEqual({
        alreadyRequested: true,
      });
    });

    it("cancelUnstartedCandidate cancels a pending or prepared candidate directly", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      const record = store.cancelUnstartedCandidate("comparison-1", "candidate-a");
      expect(record.candidates[0].status).toBe("cancelled");
    });

    it("cancelUnstartedCandidate rejects an already-running candidate", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimPreparing("comparison-1");
      store.setReady("comparison-1", {
        baseCommit: "a".repeat(40),
        candidates: [
          { candidateId: "candidate-a", executionTrust: "isolated" },
          { candidateId: "candidate-b", executionTrust: "trusted_local" },
        ],
      });
      store.claimCandidateStart("comparison-1", "candidate-a", "run-1", "agent-a");
      expect(() => store.cancelUnstartedCandidate("comparison-1", "candidate-a")).toThrow(
        ComparisonStateConflictError,
      );
    });
  });

  describe("cleanup lifecycle", () => {
    it("claimCleanup marks a non-terminal comparison cancelled, then markCleaning/setCleanupCompleted finish it", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());

      const claimed = store.claimCleanup("comparison-1");
      expect(claimed.status).toBe("cancelled");
      expect(claimed.cleanupStatus).toBe("in_progress");

      store.markCleaning("comparison-1");
      expect(store.get("comparison-1").status).toBe("cleaning");

      const completed = store.setCleanupCompleted("comparison-1");
      expect(completed.status).toBe("cleaned");
      expect(completed.cleanupStatus).toBe("completed");
    });

    it("preserves a terminal outcome status (does not overwrite completed with cancelled) when cleanup begins", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord({ status: "completed" }));
      const claimed = store.claimCleanup("comparison-1");
      expect(claimed.status).toBe("completed");
    });

    it("rejects claimCleanup while preparing is in flight", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimPreparing("comparison-1");
      expect(() => store.claimCleanup("comparison-1")).toThrow(ComparisonStateConflictError);
    });

    it("rejects a second concurrent claimCleanup while one is already in progress", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimCleanup("comparison-1");
      expect(() => store.claimCleanup("comparison-1")).toThrow(ComparisonStateConflictError);
    });

    it("rejects claimCleanup once cleanup has already fully completed", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimCleanup("comparison-1");
      store.setCleanupCompleted("comparison-1");
      expect(() => store.claimCleanup("comparison-1")).toThrow(ComparisonStateConflictError);
    });

    it("allows retrying claimCleanup after a failed cleanup, with a bounded safe error recorded", () => {
      const store = new ComparisonStore({ maxComparisons: 10 });
      store.add(buildRecord());
      store.claimCleanup("comparison-1");
      const failed = store.setCleanupFailed("comparison-1", "removal failed: git error");
      expect(failed.cleanupStatus).toBe("failed");
      expect(failed.cleanupError).toBe("removal failed: git error");

      const retried = store.claimCleanup("comparison-1");
      expect(retried.cleanupStatus).toBe("in_progress");
      expect(retried.cleanupError).toBeUndefined();
    });
  });

  it("setPreference records and can clear a non-merging operator preference", () => {
    const store = new ComparisonStore({ maxComparisons: 10 });
    store.add(buildRecord());

    const withPreference = store.setPreference("comparison-1", {
      candidateId: "candidate-a",
      note: "faster and cleaner diff",
      recordedAt: "2026-01-01T02:00:00.000Z",
    });
    expect(withPreference.preference?.candidateId).toBe("candidate-a");

    const cleared = store.setPreference("comparison-1", undefined);
    expect(cleared.preference).toBeUndefined();
  });
});
