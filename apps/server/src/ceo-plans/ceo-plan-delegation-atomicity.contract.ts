import { describe, expect, it } from "vitest";
import { CeoPlanStateConflictError } from "../errors/app-error.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { CeoPlanStorePort } from "./ceo-plan-store-port.js";
import type { CeoPlanOrchestrator } from "./ceo-plan-orchestrator.js";

/**
 * Phase 14.1 — the harness a caller of `runCeoPlanDelegationAtomicityContractTests`
 * must build. `injectFailureOnNthTaskCreate` arms a failure that fires the
 * Nth call to the underlying `taskStore.add` (1-indexed) made by the NEXT
 * `orchestrator.delegate()` call only — call it AFTER `setupApprovedPlan()`
 * (which itself calls `taskStore.add` once, for the parent task) and
 * immediately before the `delegate()` call under test, so the count is
 * scoped to delegation's own child-task creation, not setup.
 */
export interface DelegationAtomicityHarness {
  readonly orchestrator: CeoPlanOrchestrator;
  readonly taskStore: TaskStorePort;
  readonly planStore: CeoPlanStorePort;
  setupApprovedPlan(): Promise<{ readonly planId: string; readonly mutationToken: string }>;
  injectFailureOnNthTaskCreate(n: number): void;
}

/**
 * Behavioral contract every atomic-unit coordinator must satisfy for CEO
 * plan delegation — run once against a durable harness (real SQLite +
 * `withTransaction`) and once against an ephemeral harness (in-memory +
 * `createEphemeralAtomicUnit`), proving both give identical all-or-nothing
 * behavior under injected mid-delegation failures (kickoff, "Atomic
 * delegation"). Mirrors every other Phase 13/14 store's
 * `define*ContractTests` pattern (e.g. `ceo-plan-store-contract.ts`).
 */
export function runCeoPlanDelegationAtomicityContractTests(
  label: string,
  buildHarness: () => DelegationAtomicityHarness,
): void {
  describe(`CEO plan delegation atomicity contract — ${label}`, () => {
    it("failure before the first child task is created leaves the task store untouched by this delegation attempt", async () => {
      const harness = buildHarness();
      const { planId, mutationToken } = await harness.setupApprovedPlan();
      const before = harness.taskStore.list().length; // includes the parent task setup created
      harness.injectFailureOnNthTaskCreate(1);
      await expect(harness.orchestrator.delegate(planId, mutationToken)).rejects.toThrow();
      expect(harness.taskStore.list()).toHaveLength(before);
      expect(harness.planStore.getPlan(planId).status).toBe("approved");
    });

    it("failure after the first child task is created leaves no child task visible", async () => {
      const harness = buildHarness();
      const { planId, mutationToken } = await harness.setupApprovedPlan();
      const before = harness.taskStore.list().length;
      harness.injectFailureOnNthTaskCreate(2);
      await expect(harness.orchestrator.delegate(planId, mutationToken)).rejects.toThrow();
      expect(harness.taskStore.list()).toHaveLength(before);
      expect(harness.planStore.getPlan(planId).status).toBe("approved");
    });

    it("failure while creating the final child task leaves no child task visible — not just the last one", async () => {
      const harness = buildHarness();
      const { planId, mutationToken } = await harness.setupApprovedPlan();
      const before = harness.taskStore.list().length;
      harness.injectFailureOnNthTaskCreate(3);
      await expect(harness.orchestrator.delegate(planId, mutationToken)).rejects.toThrow();
      expect(harness.taskStore.list()).toHaveLength(before);
    });

    it("repeated delegation after a failed attempt succeeds exactly once, with no duplicate child tasks", async () => {
      const harness = buildHarness();
      const { planId, mutationToken } = await harness.setupApprovedPlan();
      const before = harness.taskStore.list().length;
      harness.injectFailureOnNthTaskCreate(2);
      await expect(harness.orchestrator.delegate(planId, mutationToken)).rejects.toThrow();
      expect(harness.taskStore.list()).toHaveLength(before);

      const freshToken = harness.orchestrator.getMutationToken(planId);
      const result = await harness.orchestrator.delegate(planId, freshToken);
      expect(result.childTasks.length).toBeGreaterThan(0);
      expect(harness.taskStore.list()).toHaveLength(before + result.childTasks.length);

      await expect(
        harness.orchestrator.delegate(planId, harness.orchestrator.getMutationToken(planId)),
      ).rejects.toThrow(CeoPlanStateConflictError);
      expect(harness.taskStore.list()).toHaveLength(before + result.childTasks.length); // no duplicates
    });

    it("plan status remains approved after any failed delegation attempt, never left in a half-delegated state", async () => {
      const harness = buildHarness();
      const { planId, mutationToken } = await harness.setupApprovedPlan();
      harness.injectFailureOnNthTaskCreate(2);
      await expect(harness.orchestrator.delegate(planId, mutationToken)).rejects.toThrow();
      expect(harness.planStore.getPlan(planId).status).toBe("approved");
      expect(harness.planStore.listDelegationLinks(planId)).toHaveLength(0);
    });

    // Phase 14.1 — the harnesses this contract runs against build their
    // composition via `createServerComposition`, which wires the real
    // task-mutation hook (`wrapTaskStoreWithMutationHook`). Each child
    // task created inside `delegate()`'s own atomic-unit callback fires
    // that hook's `notify()` synchronously, mid-transaction — this
    // proves the resulting `onChildTaskMutated` call is a safe no-op
    // (the child isn't linked to any plan yet at that point — see
    // `CeoPlanOrchestrator.onChildTaskMutated`'s doc comment) rather than
    // leaking a `ceo.plan.progress_changed`/`ceo.plan.delegated` event to
    // a subscriber for a delegation attempt that then rolls back.
    it("no plan event of any kind reaches a subscriber for a delegation attempt that fails and rolls back", async () => {
      const harness = buildHarness();
      const { planId, mutationToken } = await harness.setupApprovedPlan();
      const received: string[] = [];
      harness.orchestrator.subscribeToPlanEvents(planId, (event) => received.push(event.type));

      harness.injectFailureOnNthTaskCreate(2);
      await expect(harness.orchestrator.delegate(planId, mutationToken)).rejects.toThrow();

      expect(received).toEqual([]);
    });
  });
}
