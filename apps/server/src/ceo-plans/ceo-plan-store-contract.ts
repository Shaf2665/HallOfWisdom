import { describe, expect, it } from "vitest";
import { ceoPlanSchema, ceoPlanVersionSchema } from "@hall-of-wisdom/protocol";
import {
  CeoPlanApprovalBindingError,
  CeoPlanNotFoundError,
  CeoPlanStateConflictError,
  CeoPlanVersionNotFoundError,
} from "../errors/app-error.js";
import type {
  CeoPlanStorePort,
  CeoPlanVersionContent,
  CreatePlanInput,
} from "./ceo-plan-store-port.js";

function content(overrides: Partial<CeoPlanVersionContent> = {}): CeoPlanVersionContent {
  return {
    objective: "Fix the bug",
    summary: "One step",
    assumptions: [],
    constraints: [],
    steps: [
      {
        id: "step-1",
        position: 0,
        title: "Investigate",
        objective: "Find the root cause",
        boundedInstructions: "Read the logs",
        acceptanceCriteria: ["Root cause documented"],
        dependencies: [],
        routingSummary: "n/a",
      },
    ],
    ...overrides,
  };
}

function createInput(overrides: Partial<CreatePlanInput> = {}): CreatePlanInput {
  return {
    planId: "plan-1",
    parentTaskId: "task-1",
    createdBy: "ceo_planner",
    createdAt: "2026-01-01T00:00:00.000Z",
    content: content(),
    contentHash: "a".repeat(64),
    ...overrides,
  };
}

/**
 * Behavioral contract every `CeoPlanStorePort` implementation must
 * satisfy — run once against `InMemoryCeoPlanStore` and once against
 * `SqliteCeoPlanStore`, mirroring every other Phase 13/14 store's
 * contract-test pattern (e.g. `tasks/task-store-contract.ts`). Fencing,
 * restart persistence, and "no projection/publication after rollback"
 * are SQLite-specific and covered separately in
 * `sqlite-ceo-plan-store.test.ts` — they have no ephemeral-mode
 * equivalent to run this same contract against.
 */
export function defineCeoPlanStoreContractTests(
  label: string,
  createStore: () => CeoPlanStorePort,
): void {
  describe(`CeoPlanStorePort contract — ${label}`, () => {
    it("creates a plan at version 1, status draft, revision-visible only internally", () => {
      const store = createStore();
      const { plan, version } = store.createPlan(createInput());
      expect(plan.status).toBe("draft");
      expect(plan.activeVersion).toBe(1);
      expect(version.version).toBe(1);
      expect(ceoPlanSchema.safeParse(plan).success).toBe(true);
      expect(ceoPlanVersionSchema.safeParse(version).success).toBe(true);
      expect(store.getRevision("plan-1")).toBe(0);
    });

    it("getPlan/getVersion round-trip exactly what was created", () => {
      const store = createStore();
      store.createPlan(createInput());
      expect(store.getPlan("plan-1").id).toBe("plan-1");
      expect(store.getVersion("plan-1", 1).objective).toBe("Fix the bug");
    });

    it("throws CeoPlanNotFoundError for an unknown plan", () => {
      const store = createStore();
      expect(() => store.getPlan("ghost")).toThrow(CeoPlanNotFoundError);
    });

    it("throws CeoPlanVersionNotFoundError for an unknown version of a real plan", () => {
      const store = createStore();
      store.createPlan(createInput());
      expect(() => store.getVersion("plan-1", 99)).toThrow(CeoPlanVersionNotFoundError);
    });

    it("createVersion from draft creates version 2, resets status to draft, and leaves version 1 unchanged (historical immutability)", () => {
      const store = createStore();
      store.createPlan(createInput());
      const { plan, version } = store.createVersion({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        createdBy: "operator",
        createdAt: "2026-01-01T00:05:00.000Z",
        content: content({ summary: "Revised summary" }),
        contentHash: "b".repeat(64),
      });
      expect(version.version).toBe(2);
      expect(plan.activeVersion).toBe(2);
      expect(plan.status).toBe("draft");

      const v1 = store.getVersion("plan-1", 1);
      expect(v1.summary).toBe("One step");
      const v2 = store.getVersion("plan-1", 2);
      expect(v2.summary).toBe("Revised summary");
      expect(store.listVersions("plan-1")).toHaveLength(2);
    });

    it("rejects createVersion with a stale expectedRevision", () => {
      const store = createStore();
      store.createPlan(createInput());
      expect(() =>
        store.createVersion({
          planId: "plan-1",
          expectedRevision: 999,
          createdBy: "operator",
          createdAt: "2026-01-01T00:05:00.000Z",
          content: content(),
          contentHash: "b".repeat(64),
        }),
      ).toThrow(CeoPlanStateConflictError);
    });

    it("createVersion is allowed from awaiting_approval, resetting the plan to draft", () => {
      const store = createStore();
      store.createPlan(createInput());
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      const { plan, version } = store.createVersion({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        createdBy: "operator",
        createdAt: "2026-01-01T00:05:00.000Z",
        content: content({ summary: "Edited while awaiting approval" }),
        contentHash: "b".repeat(64),
      });
      expect(version.version).toBe(2);
      expect(plan.status).toBe("draft");
      expect(plan.activeVersion).toBe(2);
    });

    it("createVersion is allowed from approved (but not yet delegated), resetting the plan to draft", () => {
      const store = createStore();
      store.createPlan(createInput());
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      store.decideApproval({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "approve",
        operatorNote: undefined,
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      const { plan } = store.createVersion({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        createdBy: "operator",
        createdAt: "2026-01-01T00:11:00.000Z",
        content: content({ summary: "Edited after approval, before delegation" }),
        contentHash: "b".repeat(64),
      });
      expect(plan.status).toBe("draft");
      expect(plan.activeVersion).toBe(2);
    });

    it("createVersion is rejected once a plan is delegated — delegated plans remain immutable", () => {
      const store = createStore();
      store.createPlan(createInput());
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      store.decideApproval({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "approve",
        operatorNote: undefined,
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      store.recordDelegation({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        approvedVersion: 1,
        approvedContentHash: "a".repeat(64),
        links: [{ stepId: "step-1", childTaskId: "child-task-1", adapterId: "hall.claude-code" }],
        delegatedAt: "2026-01-01T00:15:00.000Z",
      });

      expect(() =>
        store.createVersion({
          planId: "plan-1",
          expectedRevision: store.getRevision("plan-1"),
          createdBy: "operator",
          createdAt: "2026-01-01T00:16:00.000Z",
          content: content({ summary: "Should be rejected" }),
          contentHash: "c".repeat(64),
        }),
      ).toThrow(CeoPlanStateConflictError);
      expect(store.listVersions("plan-1")).toHaveLength(1);
    });

    it("full happy path: submit -> approve exact version -> delegate", () => {
      const store = createStore();
      store.createPlan(createInput());
      const submitted = store.submit({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
      });
      expect(submitted.status).toBe("awaiting_approval");

      const { plan: approvedPlan, approval } = store.decideApproval({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "approve",
        operatorNote: undefined,
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      expect(approvedPlan.status).toBe("approved");
      expect(approval.decision).toBe("approve");

      const { plan: delegatedPlan, links } = store.recordDelegation({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        approvedVersion: 1,
        approvedContentHash: "a".repeat(64),
        links: [{ stepId: "step-1", childTaskId: "child-task-1", adapterId: "hall.claude-code" }],
        delegatedAt: "2026-01-01T00:15:00.000Z",
      });
      expect(delegatedPlan.status).toBe("delegated");
      expect(delegatedPlan.delegatedAt).toBe("2026-01-01T00:15:00.000Z");
      expect(links).toHaveLength(1);
      expect(store.listDelegationLinks("plan-1")).toHaveLength(1);
    });

    it("reject binds to the exact submitted version and moves status to rejected, preserving history", () => {
      const store = createStore();
      store.createPlan(createInput());
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      const { plan } = store.decideApproval({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "reject",
        operatorNote: "Needs another step.",
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      expect(plan.status).toBe("rejected");
      const approvals = store.listApprovals("plan-1");
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.decision).toBe("reject");
    });

    it("rejects an approval decision whose contentHash does not match the active version's stored hash", () => {
      const store = createStore();
      store.createPlan(createInput());
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      expect(() =>
        store.decideApproval({
          planId: "plan-1",
          expectedRevision: store.getRevision("plan-1"),
          planVersion: 1,
          contentHash: "c".repeat(64),
          decision: "approve",
          operatorNote: undefined,
          decidedAt: "2026-01-01T00:10:00.000Z",
        }),
      ).toThrow(CeoPlanApprovalBindingError);
    });

    it("rejects an approval decision targeting a version that is no longer active (edit invalidates the previous approval binding)", () => {
      const store = createStore();
      store.createPlan(createInput());
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      // A rejection first, so the plan can be edited again.
      store.decideApproval({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "reject",
        operatorNote: undefined,
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      store.createVersion({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        createdBy: "operator",
        createdAt: "2026-01-01T00:11:00.000Z",
        content: content({ summary: "v2" }),
        contentHash: "b".repeat(64),
      });
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });

      // An old approval request for version 1 must never authorize version 2.
      expect(() =>
        store.decideApproval({
          planId: "plan-1",
          expectedRevision: store.getRevision("plan-1"),
          planVersion: 1,
          contentHash: "a".repeat(64),
          decision: "approve",
          operatorNote: undefined,
          decidedAt: "2026-01-01T00:12:00.000Z",
        }),
      ).toThrow(CeoPlanApprovalBindingError);
    });

    it("two simultaneous approval requests cannot both create conflicting active decisions — the second sees a stale revision", () => {
      const store = createStore();
      store.createPlan(createInput());
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      const snapshotRevision = store.getRevision("plan-1");

      store.decideApproval({
        planId: "plan-1",
        expectedRevision: snapshotRevision,
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "approve",
        operatorNote: undefined,
        decidedAt: "2026-01-01T00:10:00.000Z",
      });

      // A second request that snapshotted the same (now stale) revision.
      expect(() =>
        store.decideApproval({
          planId: "plan-1",
          expectedRevision: snapshotRevision,
          planVersion: 1,
          contentHash: "a".repeat(64),
          decision: "reject",
          operatorNote: undefined,
          decidedAt: "2026-01-01T00:10:01.000Z",
        }),
      ).toThrow(CeoPlanStateConflictError);

      expect(store.getPlan("plan-1").status).toBe("approved");
      expect(store.listApprovals("plan-1")).toHaveLength(1);
    });

    it("cancel is allowed before delegation and is terminal", () => {
      const store = createStore();
      store.createPlan(createInput());
      const cancelled = store.cancel({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
      });
      expect(cancelled.status).toBe("cancelled");
      expect(() =>
        store.cancel({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") }),
      ).toThrow(CeoPlanStateConflictError);
    });

    it("delegate can only happen once — a second delegation attempt is rejected, with no duplicate links created", () => {
      const store = createStore();
      store.createPlan(createInput());
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      store.decideApproval({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "approve",
        operatorNote: undefined,
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      store.recordDelegation({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        approvedVersion: 1,
        approvedContentHash: "a".repeat(64),
        links: [{ stepId: "step-1", childTaskId: "child-task-1", adapterId: "hall.claude-code" }],
        delegatedAt: "2026-01-01T00:15:00.000Z",
      });

      expect(() =>
        store.recordDelegation({
          planId: "plan-1",
          expectedRevision: store.getRevision("plan-1"),
          approvedVersion: 1,
          approvedContentHash: "a".repeat(64),
          links: [{ stepId: "step-1", childTaskId: "child-task-2", adapterId: "hall.codex" }],
          delegatedAt: "2026-01-01T00:16:00.000Z",
        }),
      ).toThrow();
      expect(store.listDelegationLinks("plan-1")).toHaveLength(1);
      expect(store.listDelegationLinks("plan-1")[0]?.childTaskId).toBe("child-task-1");
    });

    it("delegate rejects when the plan is not yet approved, creating no links", () => {
      const store = createStore();
      store.createPlan(createInput());
      expect(() =>
        store.recordDelegation({
          planId: "plan-1",
          expectedRevision: store.getRevision("plan-1"),
          approvedVersion: 1,
          approvedContentHash: "a".repeat(64),
          links: [{ stepId: "step-1", childTaskId: "child-task-1", adapterId: "hall.claude-code" }],
          delegatedAt: "2026-01-01T00:15:00.000Z",
        }),
      ).toThrow(CeoPlanStateConflictError);
      expect(store.listDelegationLinks("plan-1")).toHaveLength(0);
    });

    it("findPlanIdByChildTaskId is undefined before delegation and resolves to the plan after", () => {
      const store = createStore();
      store.createPlan(createInput());
      expect(store.findPlanIdByChildTaskId("child-task-1")).toBeUndefined();

      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      store.decideApproval({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "approve",
        operatorNote: undefined,
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      store.recordDelegation({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        approvedVersion: 1,
        approvedContentHash: "a".repeat(64),
        links: [{ stepId: "step-1", childTaskId: "child-task-1", adapterId: "hall.claude-code" }],
        delegatedAt: "2026-01-01T00:15:00.000Z",
      });
      expect(store.findPlanIdByChildTaskId("child-task-1")).toBe("plan-1");
      expect(store.findPlanIdByChildTaskId("unrelated-task")).toBeUndefined();
    });

    it("getLastProgressFingerprint is undefined until syncProgress has been called at least once", () => {
      const store = createStore();
      store.createPlan(createInput());
      expect(store.getLastProgressFingerprint("plan-1")).toBeUndefined();
    });

    it("syncProgress updates the fingerprint and appends exactly one event, without changing plan status when newStatus is omitted", () => {
      const store = createStore();
      store.createPlan(createInput());
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      store.decideApproval({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "approve",
        operatorNote: undefined,
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      store.recordDelegation({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        approvedVersion: 1,
        approvedContentHash: "a".repeat(64),
        links: [{ stepId: "step-1", childTaskId: "child-task-1", adapterId: "hall.claude-code" }],
        delegatedAt: "2026-01-01T00:15:00.000Z",
      });

      const { plan, event } = store.syncProgress({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        fingerprint: "fp-1",
        now: "2026-01-01T00:16:00.000Z",
        eventType: "ceo.plan.progress_changed",
        eventPayload: { completed: 0, running: 1, failed: 0, blocked: 0, totalSteps: 1 },
      });
      expect(plan.status).toBe("delegated");
      expect(event.type).toBe("ceo.plan.progress_changed");
      expect(store.getLastProgressFingerprint("plan-1")).toBe("fp-1");
      expect(
        store.listEvents("plan-1").filter((e) => e.type === "ceo.plan.progress_changed"),
      ).toHaveLength(1);
    });

    it("syncProgress transitions the plan to the given terminal status and sets completedAt", () => {
      const store = createStore();
      store.createPlan(createInput());
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      store.decideApproval({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "approve",
        operatorNote: undefined,
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      store.recordDelegation({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        approvedVersion: 1,
        approvedContentHash: "a".repeat(64),
        links: [{ stepId: "step-1", childTaskId: "child-task-1", adapterId: "hall.claude-code" }],
        delegatedAt: "2026-01-01T00:15:00.000Z",
      });

      const { plan, event } = store.syncProgress({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        fingerprint: "fp-done",
        now: "2026-01-01T00:20:00.000Z",
        eventType: "ceo.plan.completed",
        eventPayload: { completed: 1, running: 0, failed: 0, blocked: 0, totalSteps: 1 },
        newStatus: "completed",
      });
      expect(plan.status).toBe("completed");
      expect(plan.completedAt).toBe("2026-01-01T00:20:00.000Z");
      expect(event.type).toBe("ceo.plan.completed");
    });

    it("syncProgress rejects a plan that is not currently delegated", () => {
      const store = createStore();
      store.createPlan(createInput());
      expect(() =>
        store.syncProgress({
          planId: "plan-1",
          expectedRevision: store.getRevision("plan-1"),
          fingerprint: "fp-1",
          now: "2026-01-01T00:00:00.000Z",
          eventType: "ceo.plan.progress_changed",
          eventPayload: {},
        }),
      ).toThrow(CeoPlanStateConflictError);
    });

    it("syncProgress rejects a stale expectedRevision", () => {
      const store = createStore();
      store.createPlan(createInput());
      store.submit({ planId: "plan-1", expectedRevision: store.getRevision("plan-1") });
      store.decideApproval({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        planVersion: 1,
        contentHash: "a".repeat(64),
        decision: "approve",
        operatorNote: undefined,
        decidedAt: "2026-01-01T00:10:00.000Z",
      });
      store.recordDelegation({
        planId: "plan-1",
        expectedRevision: store.getRevision("plan-1"),
        approvedVersion: 1,
        approvedContentHash: "a".repeat(64),
        links: [{ stepId: "step-1", childTaskId: "child-task-1", adapterId: "hall.claude-code" }],
        delegatedAt: "2026-01-01T00:15:00.000Z",
      });
      expect(() =>
        store.syncProgress({
          planId: "plan-1",
          expectedRevision: 999,
          fingerprint: "fp-1",
          now: "2026-01-01T00:16:00.000Z",
          eventType: "ceo.plan.progress_changed",
          eventPayload: {},
        }),
      ).toThrow(CeoPlanStateConflictError);
    });

    it("appendEvent assigns a monotonic, zero-based sequence per plan", () => {
      const store = createStore();
      store.createPlan(createInput());
      const e0 = store.appendEvent(
        "plan-1",
        "ceo.plan.created",
        { stepCount: 1 },
        "2026-01-01T00:00:00.000Z",
      );
      const e1 = store.appendEvent("plan-1", "ceo.plan.submitted", {}, "2026-01-01T00:01:00.000Z");
      expect(e0.sequence).toBe(0);
      expect(e1.sequence).toBe(1);
      expect(store.listEvents("plan-1")).toHaveLength(2);
      expect(store.listEvents("plan-1", 0)).toEqual([e1]);
    });

    it("listPlansForParentTask returns only plans for that parent task", () => {
      const store = createStore();
      store.createPlan(createInput({ planId: "plan-a", parentTaskId: "task-a" }));
      store.createPlan(createInput({ planId: "plan-b", parentTaskId: "task-b" }));
      const forA = store.listPlansForParentTask("task-a");
      expect(forA).toHaveLength(1);
      expect(forA[0]?.id).toBe("plan-a");
    });

    it("the public CeoPlan/CeoPlanVersion shapes returned by the store never carry an internal revision field", () => {
      const store = createStore();
      const { plan, version } = store.createPlan(createInput());
      expect(JSON.stringify(plan)).not.toContain("revision");
      expect(JSON.stringify(version)).not.toContain("internalRevision");
    });
  });
}
