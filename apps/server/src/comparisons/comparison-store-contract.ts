import { describe, expect, it } from "vitest";
import {
  ComparisonCandidateNotFoundError,
  ComparisonStateConflictError,
} from "../errors/app-error.js";
import type { AgentComparisonRecord, ComparisonCandidateRecord } from "./comparison-record.js";
import type { ComparisonStorePort } from "./comparison-store-port.js";

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
    createdAt: overrides.createdAt ?? NOW,
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

function buildRecord(
  comparisonId: string,
  overrides: Partial<AgentComparisonRecord> = {},
): AgentComparisonRecord {
  return {
    comparisonId,
    sourceTaskId: overrides.sourceTaskId ?? "task-1",
    title: overrides.title ?? "Compare agents",
    description: overrides.description ?? "",
    priority: overrides.priority ?? "normal",
    requirements: overrides.requirements,
    baseCommit: overrides.baseCommit,
    status: overrides.status ?? "draft",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    preparedAt: overrides.preparedAt,
    candidates: overrides.candidates ?? [
      buildCandidate(`${comparisonId}-a`, { adapterId: "hall.claude-code" }),
      buildCandidate(`${comparisonId}-b`, { adapterId: "hall.codex" }),
    ],
    cleanupStatus: overrides.cleanupStatus ?? "not_started",
    cleanupError: overrides.cleanupError,
    prepareFailureCode: overrides.prepareFailureCode,
    prepareFailureReason: overrides.prepareFailureReason,
    preference: overrides.preference,
  };
}

/**
 * Behavioral contract every `ComparisonStorePort` implementation must
 * satisfy — run once against the in-memory `ComparisonStore` and once
 * against `SqliteComparisonStore` (Phase 13's durable-mode sibling).
 */
export function defineComparisonStoreContractTests(
  label: string,
  createStore: () => ComparisonStorePort,
): void {
  describe(`ComparisonStorePort contract (${label})`, () => {
    it("successful mutation increments the revision exactly once", () => {
      const store = createStore();
      store.add(buildRecord("cmp-1"));
      const r0 = store.getRevision("cmp-1");
      store.claimPreparing("cmp-1");
      expect(store.getRevision("cmp-1")).toBe(r0 + 1);
    });

    it("a rejected mutation does not increment the revision", () => {
      const store = createStore();
      store.add(buildRecord("cmp-1", { status: "cleaned" }));
      const r0 = store.getRevision("cmp-1");
      expect(() => store.claimPreparing("cmp-1")).toThrow(ComparisonStateConflictError);
      expect(store.getRevision("cmp-1")).toBe(r0);
    });

    it("full prepare -> ready lifecycle sets baseCommit and moves both candidates to prepared", () => {
      const store = createStore();
      const record = buildRecord("cmp-1");
      store.add(record);
      store.claimPreparing("cmp-1");
      const [a, b] = record.candidates;
      const ready = store.setReady("cmp-1", {
        baseCommit: "a".repeat(40),
        candidates: [
          { candidateId: a.candidateId, executionTrust: "isolated" },
          { candidateId: b.candidateId, executionTrust: "trusted_local" },
        ],
      });
      expect(ready.status).toBe("ready");
      expect(ready.baseCommit).toBe("a".repeat(40));
      expect(ready.candidates[0].status).toBe("prepared");
      expect(ready.candidates[1].status).toBe("prepared");
      expect(ready.candidates[0].executionTrust).toBe("isolated");
    });

    it("setPrepareFailed moves to failed and records comparison-level code/reason", () => {
      const store = createStore();
      store.add(buildRecord("cmp-1"));
      store.claimPreparing("cmp-1");
      const failed = store.setPrepareFailed("cmp-1", undefined, "TEST_CODE", "safe reason");
      expect(failed.status).toBe("failed");
      expect(failed.prepareFailureCode).toBe("TEST_CODE");
      expect(failed.prepareFailureReason).toBe("safe reason");
    });

    it("claimCandidateStart rejects starting a second candidate while another is running (sequential-only)", () => {
      const store = createStore();
      const record = buildRecord("cmp-1");
      store.add(record);
      store.claimPreparing("cmp-1");
      const [a, b] = record.candidates;
      store.setReady("cmp-1", {
        baseCommit: "a".repeat(40),
        candidates: [
          { candidateId: a.candidateId, executionTrust: "isolated" },
          { candidateId: b.candidateId, executionTrust: "isolated" },
        ],
      });
      store.claimCandidateStart("cmp-1", a.candidateId, "run-1", "agent-a");
      expect(() => store.claimCandidateStart("cmp-1", b.candidateId, "run-2", "agent-b")).toThrow(
        ComparisonStateConflictError,
      );
    });

    it("setCandidateCompleted recomputes comparison status to completed once both candidates finish", () => {
      const store = createStore();
      const record = buildRecord("cmp-1");
      store.add(record);
      store.claimPreparing("cmp-1");
      const [a, b] = record.candidates;
      store.setReady("cmp-1", {
        baseCommit: "a".repeat(40),
        candidates: [
          { candidateId: a.candidateId, executionTrust: "isolated" },
          { candidateId: b.candidateId, executionTrust: "isolated" },
        ],
      });
      store.claimCandidateStart("cmp-1", a.candidateId, "run-1", "agent-a");
      const afterA = store.setCandidateCompleted("cmp-1", a.candidateId, {
        completedAt: NOW,
        terminalEventType: "run.completed",
      });
      expect(afterA.status).toBe("running"); // b hasn't started/finished yet
      store.claimCandidateStart("cmp-1", b.candidateId, "run-2", "agent-b");
      const afterB = store.setCandidateCompleted("cmp-1", b.candidateId, {
        completedAt: NOW,
        terminalEventType: "run.completed",
      });
      expect(afterB.status).toBe("completed");
    });

    it("cleanup lifecycle: claimCleanup -> markCleaning -> setCleanupCompleted", () => {
      const store = createStore();
      store.add(buildRecord("cmp-1", { status: "ready" }));
      const claimed = store.claimCleanup("cmp-1");
      expect(claimed.cleanupStatus).toBe("in_progress");
      expect(claimed.status).toBe("cancelled"); // was ready, torn down before finishing naturally
      store.markCleaning("cmp-1");
      expect(store.get("cmp-1").status).toBe("cleaning");
      const completed = store.setCleanupCompleted("cmp-1");
      expect(completed.cleanupStatus).toBe("completed");
      expect(completed.status).toBe("cleaned");
    });

    it("claimCleanup rejects a second concurrent cleanup while one is already in progress", () => {
      const store = createStore();
      store.add(buildRecord("cmp-1", { status: "ready" }));
      store.claimCleanup("cmp-1");
      expect(() => store.claimCleanup("cmp-1")).toThrow(ComparisonStateConflictError);
    });

    it("setPreference records and clears a non-merging, non-status-affecting preference", () => {
      const store = createStore();
      const record = buildRecord("cmp-1");
      store.add(record);
      const [a] = record.candidates;
      const withPreference = store.setPreference("cmp-1", {
        candidateId: a.candidateId,
        note: "faster",
        recordedAt: NOW,
      });
      expect(withPreference.preference?.candidateId).toBe(a.candidateId);
      expect(withPreference.status).toBe("draft"); // unaffected
      const cleared = store.setPreference("cmp-1", undefined);
      expect(cleared.preference).toBeUndefined();
    });

    it("get()/list() never expose revision", () => {
      const store = createStore();
      store.add(buildRecord("cmp-1"));
      const record = store.get("cmp-1");
      expect(Object.keys(record)).not.toContain("revision");
      const [listed] = store.list();
      expect(Object.keys(listed as object)).not.toContain("revision");
    });

    it("candidate operations throw ComparisonCandidateNotFoundError for an unknown candidate", () => {
      const store = createStore();
      store.add(buildRecord("cmp-1"));
      expect(() => {
        store.recordCandidateEventMeta("cmp-1", "does-not-exist", 0);
      }).toThrow(ComparisonCandidateNotFoundError);
    });

    it("list() returns comparisons in insertion order", () => {
      const store = createStore();
      store.add(buildRecord("cmp-1"));
      store.add(buildRecord("cmp-2"));
      expect(store.list().map((r) => r.comparisonId)).toEqual(["cmp-1", "cmp-2"]);
    });
  });
}
