import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { CLAUDE_CODE_ADAPTER_ID } from "@hall-of-wisdom/claude-code-adapter";
import { CODEX_ADAPTER_ID } from "@hall-of-wisdom/codex-adapter";
import {
  createServerComposition,
  type ServerComposition,
} from "../composition/server-composition.js";
import { resolveDataDir } from "../persistence/database-config.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { DEFAULT_LIMITS } from "../config/server-config.js";
import {
  runCeoPlanDelegationAtomicityContractTests,
  type DelegationAtomicityHarness,
} from "./ceo-plan-delegation-atomicity.contract.js";

/**
 * Phase 14.1 — durable-mode call site for the shared delegation atomicity
 * contract, mirroring `ceo-plan-durable-restart.test.ts`'s pattern of
 * driving the real `createServerComposition` entry point over a genuine
 * `HallDatabase`. Proves `withTransaction`'s reentrant SAVEPOINT nesting
 * gives the exact same all-or-nothing delegation behavior the ephemeral
 * call site proves for `createEphemeralAtomicUnit`.
 *
 * See the ephemeral call site's matching doc comment for why
 * `stubExternalProviderDetection` exists: `createServerComposition`
 * always registers real Claude Code and Codex adapters, and
 * `delegate()`'s `detectRoutingCandidates()` call spawns real CLI
 * subprocesses for both unless stubbed — measured to cause a genuine
 * "Test timed out in 10000ms" failure under full-monorepo parallel load
 * for the "repeated delegation" scenario's two `delegate()` calls.
 */

let tempRoot: string | undefined;
const openDbs: HallDatabase[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  if (tempRoot !== undefined) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function stubExternalProviderDetection(composition: ServerComposition): void {
  for (const adapterId of [CLAUDE_CODE_ADAPTER_ID, CODEX_ADAPTER_ID]) {
    vi.spyOn(composition.registry.resolve(adapterId), "detect").mockResolvedValue({
      installed: false,
      availability: "unavailable",
    });
  }
}

function buildDurableComposition() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-ceo-plan-atomicity-durable-"));
  const workspaceDir = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceDir);
  const workspaceRoot = fs.realpathSync.native(workspaceDir);
  const dataDir = resolveDataDir({
    dataDir: path.join(tempRoot, "data"),
    workspaceRoot,
  });
  const db = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
  runMigrations(db);
  openDbs.push(db);
  const composition = createServerComposition({
    workspaceRoot,
    mockScenario: "success",
    mockStepDelayMs: 0,
    limits: DEFAULT_LIMITS,
    db,
    agentWorktreeRoot: path.join(dataDir, "agent-worktrees"),
  });
  stubExternalProviderDetection(composition);
  return composition;
}

function buildHarness(): DelegationAtomicityHarness {
  const composition = buildDurableComposition();
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
      // plain object), not a raw `SqliteTaskStore` instance — capture the
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

runCeoPlanDelegationAtomicityContractTests("durable", buildHarness);
