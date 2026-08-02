import { describe, expect, it } from "vitest";
import {
  AgentWorktreeConflictError,
  AgentWorktreeInvalidTransitionError,
} from "./agent-worktree-errors.js";
import type { AgentWorktreeStorePort } from "./agent-worktree-store-port.js";

const NOW = "2026-08-02T10:00:00.000Z";
const LATER = "2026-08-02T10:01:00.000Z";

export function runAgentWorktreeStoreContractTests(
  label: string,
  buildStore: () => AgentWorktreeStorePort,
): void {
  describe(`AgentWorktreeStorePort contract — ${label}`, () => {
    it("creates and retrieves a creating record", () => {
      const store = buildStore();
      const created = store.createCreating(recordInput("wt-1", "run-1", NOW));
      expect(created.status).toBe("creating");
      expect(created.revision).toBe(0);
      expect(store.get("wt-1")).toEqual(created);
    });

    it("lists records in deterministic creation time then id order", () => {
      const store = buildStore();
      store.createCreating(recordInput("wt-b", "run-b", LATER));
      store.createCreating(recordInput("wt-c", "run-c", NOW));
      store.createCreating(recordInput("wt-a", "run-a", NOW));
      expect(store.list().map((record) => record.worktreeId)).toEqual(["wt-a", "wt-c", "wt-b"]);
    });

    it("rejects a duplicate worktree id", () => {
      const store = buildStore();
      store.createCreating(recordInput("wt-1", "run-1", NOW));
      expect(() => store.createCreating(recordInput("wt-1", "run-2", NOW))).toThrow(
        AgentWorktreeConflictError,
      );
    });

    it("rejects a second active worktree for the same agent run id", () => {
      const store = buildStore();
      store.createCreating(recordInput("wt-1", "run-1", NOW));
      expect(() => store.createCreating(recordInput("wt-2", "run-1", LATER))).toThrow(
        AgentWorktreeConflictError,
      );
    });

    it("allows a second worktree for the same agent run once the first creation failed", () => {
      const store = buildStore();
      store.createCreating(recordInput("wt-1", "run-1", NOW));
      store.markCreationFailed({
        worktreeId: "wt-1",
        expectedRevision: 0,
        safeFailureCode: "GIT_FAILURE",
        safeFailureSummary: "failed",
        now: LATER,
      });
      expect(() => store.createCreating(recordInput("wt-2", "run-1", LATER))).not.toThrow();
    });

    it("valid lifecycle transitions increment revision", () => {
      const store = buildStore();
      store.createCreating(recordInput("wt-1", "run-1", NOW));
      const ready = store.markReady({ worktreeId: "wt-1", expectedRevision: 0, readyAt: LATER });
      expect(ready.status).toBe("ready");
      expect(ready.revision).toBe(1);
      const pending = store.requestCleanup({
        worktreeId: "wt-1",
        expectedRevision: ready.revision,
        now: LATER,
      });
      expect(pending.status).toBe("cleanup_pending");
      expect(pending.revision).toBe(2);
      const cleaned = store.markCleaned({
        worktreeId: "wt-1",
        expectedRevision: pending.revision,
        now: LATER,
      });
      expect(cleaned.status).toBe("cleaned");
      expect(cleaned.revision).toBe(3);
    });

    it("invalid lifecycle transitions are rejected without incrementing revision", () => {
      const store = buildStore();
      store.createCreating(recordInput("wt-1", "run-1", NOW));
      expect(() =>
        store.markCleaned({ worktreeId: "wt-1", expectedRevision: 0, now: LATER }),
      ).toThrow(AgentWorktreeInvalidTransitionError);
      expect(store.get("wt-1").revision).toBe(0);
    });

    it("stale revisions are rejected without incrementing revision", () => {
      const store = buildStore();
      store.createCreating(recordInput("wt-1", "run-1", NOW));
      store.markReady({ worktreeId: "wt-1", expectedRevision: 0, readyAt: LATER });
      expect(() =>
        store.requestCleanup({ worktreeId: "wt-1", expectedRevision: 0, now: LATER }),
      ).toThrow(AgentWorktreeConflictError);
      expect(store.get("wt-1").revision).toBe(1);
    });

    it("bounds failure fields", () => {
      const store = buildStore();
      store.createCreating(recordInput("wt-1", "run-1", NOW));
      const failed = store.markCreationFailed({
        worktreeId: "wt-1",
        expectedRevision: 0,
        safeFailureCode: "unsafe code with spaces",
        safeFailureSummary: "x".repeat(800),
        now: LATER,
      });
      expect(failed.safeFailureCode).toBe("UNSAFE_CODE_WITH_SPACES");
      expect(failed.safeFailureSummary?.length).toBeLessThanOrEqual(501);
    });

    it("findActiveByAgentRunId returns only active records", () => {
      const store = buildStore();
      store.createCreating(recordInput("wt-1", "run-1", NOW));
      expect(store.findActiveByAgentRunId("run-1")?.worktreeId).toBe("wt-1");
      store.markCreationFailed({
        worktreeId: "wt-1",
        expectedRevision: 0,
        safeFailureCode: "GIT_FAILURE",
        safeFailureSummary: "failed",
        now: LATER,
      });
      expect(store.findActiveByAgentRunId("run-1")).toBeUndefined();
    });
  });
}

function recordInput(worktreeId: string, hallAgentRunId: string, createdAt: string) {
  return {
    worktreeId,
    hallTaskId: `task-${worktreeId}`,
    hallAgentRunId,
    canonicalSourceRepositoryRoot: "C:\\safe\\repo",
    sourceWorkingDirectoryRelativePath: ".",
    baseCommit: "0".repeat(40),
    canonicalWorktreePath: `C:\\safe\\root\\wt_${worktreeId}`,
    createdAt,
  };
}
