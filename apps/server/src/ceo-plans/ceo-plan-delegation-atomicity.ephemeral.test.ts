import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, vi } from "vitest";
import {
  createServerComposition,
  type ServerComposition,
} from "../composition/server-composition.js";
import { DEFAULT_LIMITS } from "../config/server-config.js";
import {
  runCeoPlanDelegationAtomicityContractTests,
  type DelegationAtomicityHarness,
} from "./ceo-plan-delegation-atomicity.contract.js";

/**
 * Phase 14.1 — ephemeral-mode call site for the shared delegation
 * atomicity contract. Builds a real, fully-wired ephemeral composition
 * via `createServerComposition` (the same entry point production and the
 * E2E fixture server use) with `db` omitted, so this proves the actual
 * `createEphemeralAtomicUnit` wiring at the composition root, not just
 * `ephemeral-atomic-unit.ts`'s own unit tests.
 */

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot !== undefined) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function buildEphemeralComposition(): ServerComposition {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-ceo-plan-atomicity-ephemeral-"));
  const workspaceRoot = fs.realpathSync.native(tempRoot);
  return createServerComposition({
    workspaceRoot,
    mockScenario: "success",
    mockStepDelayMs: 0,
    limits: DEFAULT_LIMITS,
  });
}

function buildHarness(): DelegationAtomicityHarness {
  const composition = buildEphemeralComposition();
  const { orchestrator, planStore } = composition.ceoPlans;
  const { taskStore } = composition;
  let failOnNth: number | undefined;

  return {
    orchestrator,
    taskStore,
    planStore,
    injectFailureOnNthTaskCreate(n: number): void {
      failOnNth = n;
      let calls = 0;
      // `taskStore` may be `wrapTaskStoreWithMutationHook`'s wrapper (a
      // plain object), not a raw `TaskStore` instance — capture the
      // still-real `add` bound to `taskStore` itself BEFORE installing
      // the spy, rather than assuming a concrete class whose
      // private-field-using prototype method would throw if `.apply()`d
      // against the wrapper.
      const realAdd = taskStore.add.bind(taskStore);
      vi.spyOn(taskStore, "add").mockImplementation((...args: Parameters<typeof taskStore.add>) => {
        calls += 1;
        if (calls === failOnNth) throw new Error("injected failure");
        realAdd(...args);
      });
    },
    async setupApprovedPlan() {
      const created = composition.orchestrator.createTask({
        executionMode: "deferred",
        projectId: "proj-1",
        title: "Fix the login redirect",
        description: "Login redirects to /404 instead of /dashboard after SSO callback.",
        requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
      });
      const { plan, version } = await orchestrator.createPlan(created.task.taskId, undefined);
      await orchestrator.submit(plan.id, orchestrator.getMutationToken(plan.id));
      await orchestrator.decideApproval(
        plan.id,
        orchestrator.getMutationToken(plan.id),
        1,
        version.contentHash,
        "approve",
        undefined,
      );
      return { planId: plan.id, mutationToken: orchestrator.getMutationToken(plan.id) };
    },
  };
}

runCeoPlanDelegationAtomicityContractTests("ephemeral", buildHarness);
