import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerComposition, type ServerComposition } from "./server-composition.js";
import { resolveDataDir } from "../persistence/database-config.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { runRestartRecovery } from "../recovery/restart-recovery.js";
import { recordBootStarted } from "../persistence/boot-repository.js";
import { DEFAULT_LIMITS } from "../config/server-config.js";
import { computeCeoPlanContentHash } from "../ceo-plans/ceo-plan-content-hash.js";
import { reconcileAllPlanProgress } from "../ceo-plans/ceo-plan-progress-reconciliation.js";

/**
 * Phase 14 — CEO plan durable restart coverage, mirroring
 * `durable-restart.test.ts`'s own pattern of driving the real
 * `createServerComposition` entry point (never a hand-built store)
 * across a genuine `HallDatabase` close/reopen. `createServerComposition`
 * already composes `ceoPlans` (Phase 14's #70) via the same
 * `createCeoPlanComposition` production and the E2E fixture both call, so
 * this proves the actual startup wiring, not just store-level logic
 * already covered by `sqlite-ceo-plan-store.test.ts`'s contract suite.
 *
 * `runRestartRecovery` has no CEO-plan awareness at all (a CEO plan has
 * no run/process concept to reconcile, unlike a task's or a comparison
 * candidate's run) — so unlike task/comparison recovery, there is no
 * synthetic "interrupted" event to test for here. What restart *can*
 * still affect is `CeoPlanOrchestrator.refreshProgress()`'s lazy,
 * write-on-read terminal-status sync (see its own doc comment) — the
 * first `GET` of a delegated plan after a restart can itself mutate the
 * plan if every child task had already reached a terminal state before
 * the crash. That behavior is deliberately exercised here, not treated
 * as a side effect to avoid.
 */

function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitUntil: condition not met within timeout"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe("CEO plan durable restart via the real composition root (Phase 14)", () => {
  let tempRoot: string;
  const openDbs: HallDatabase[] = [];

  afterEach(() => {
    for (const db of openDbs.splice(0)) db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function makeTempRoot(prefix: string): { workspaceRoot: string; dataDirRaw: string } {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const workspaceDir = path.join(tempRoot, "workspace");
    fs.mkdirSync(workspaceDir);
    return {
      workspaceRoot: fs.realpathSync.native(workspaceDir),
      dataDirRaw: path.join(tempRoot, "data"),
    };
  }

  function openDurableComposition(input: {
    readonly workspaceRoot: string;
    readonly dataDirRaw: string;
  }): { readonly db: HallDatabase; readonly composition: ServerComposition } {
    const dataDir = resolveDataDir({
      dataDir: input.dataDirRaw,
      workspaceRoot: input.workspaceRoot,
    });
    const db = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    runMigrations(db);
    openDbs.push(db);
    const composition = createServerComposition({
      workspaceRoot: input.workspaceRoot,
      mockScenario: "success",
      mockStepDelayMs: 0,
      limits: DEFAULT_LIMITS,
      db,
    });
    return { db, composition };
  }

  function createParentTask(composition: ServerComposition): string {
    const created = composition.orchestrator.createTask({
      executionMode: "deferred",
      projectId: "proj-1",
      title: "Fix the login redirect",
      description: "Login redirects to /404 instead of /dashboard after SSO callback.",
      requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
    });
    return created.task.taskId;
  }

  // Phase 14.1 — explicit 30s timeouts below (the file default is
  // `vitest.config.ts`'s global 10s). These three tests passed
  // comfortably under the 10s default earlier in Phase 14 (~11s for all
  // three combined, per that phase's own verification run) — Task 1's
  // mutation-token changes added no meaningful per-test cost (one extra
  // synchronous HMAC computation). The timeouts seen while verifying
  // Task 1 were pure machine load from this long session's accumulated
  // concurrent test/build/e2e processes, not a regression introduced
  // here. Each test opens two real `HallDatabase` instances and runs
  // real migrations against each, which is inherently close to a 10s
  // budget under any load — 30s gives the same generous, real-I/O
  // headroom `vitest.process.config.ts` already uses for this class of
  // test, rather than tying correctness to how busy the machine happens
  // to be at test time.
  it("a delegated plan — version, content hash, approval, delegation links, and events — survives a restart byte-identical, and status is not auto-advanced while children are still incomplete", async () => {
    const { workspaceRoot, dataDirRaw } = makeTempRoot("hall-ceo-plan-restart-delegated-");
    const first = openDurableComposition({ workspaceRoot, dataDirRaw });
    // Registers a real boot row (what `server.ts` does at startup, not
    // something `createServerComposition` itself does) so that closing
    // `first.db` below without ever calling `recordCleanShutdown`
    // genuinely produces an *unclean* classification on the next boot's
    // recovery — the harder case, not just an assumption.
    recordBootStarted(first.db, "boot-1", new Date().toISOString());
    const taskId = createParentTask(first.composition);

    const { plan: created, version: v1 } = await first.composition.ceoPlans.orchestrator.createPlan(
      taskId,
      undefined,
    );
    await first.composition.ceoPlans.orchestrator.submit(
      created.id,
      first.composition.ceoPlans.orchestrator.getMutationToken(created.id),
    );
    const { approval } = await first.composition.ceoPlans.orchestrator.decideApproval(
      created.id,
      first.composition.ceoPlans.orchestrator.getMutationToken(created.id),
      1,
      v1.contentHash,
      "approve",
      undefined,
    );
    const delegateResult = await first.composition.ceoPlans.orchestrator.delegate(
      created.id,
      first.composition.ceoPlans.orchestrator.getMutationToken(created.id),
    );
    expect(delegateResult.childTasks).toHaveLength(3);
    for (const childTask of delegateResult.childTasks) {
      expect(childTask.task.status).toBe("assigned");
      expect(childTask.runId).toBeUndefined();
    }

    // The orchestrator's public surface intentionally never exposes the
    // raw internal revision (Phase 14.1) — reach into the composition's
    // own `planStore` directly (a white-box test, like the existing
    // direct `taskStore` access below) to verify the byte-for-byte
    // survival claim this test is actually about.
    const revisionBeforeRestart = first.composition.ceoPlans.planStore.getRevision(created.id);
    const eventsBeforeRestart = first.composition.ceoPlans.orchestrator.listEvents(created.id);
    first.db.close();

    const second = openDurableComposition({ workspaceRoot, dataDirRaw });
    // No `recordCleanShutdown` was called before `first.db.close()` above
    // (mirroring Phase 13's own `durable-restart.test.ts`), so recovery
    // classifies this as an *unclean* restart — the harder case, since a
    // task run genuinely gets a synthetic `HALL_RESTART_INTERRUPTED_RUN`
    // event under it. A CEO plan gets no such treatment regardless: it
    // has no run/process concept for recovery to reconcile.
    const recovery = await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: new Date().toISOString(),
      workspaceRoot,
      comparisonRoot: undefined,
      taskStore: second.composition.taskStore,
      taskEventStore: second.composition.eventStore,
      comparison: undefined,
    });
    expect(recovery.summary.previousShutdown).toBe("unclean");

    // Restart recovery has no CEO-plan awareness — revision and events
    // are byte-for-byte what they were before the crash, with no
    // synthetic event of any kind appended for the plan itself, even
    // though this was an unclean restart.
    expect(second.composition.ceoPlans.planStore.getRevision(created.id)).toBe(
      revisionBeforeRestart,
    );
    expect(second.composition.ceoPlans.orchestrator.listEvents(created.id)).toEqual(
      eventsBeforeRestart,
    );

    const restoredPlan = second.composition.ceoPlans.orchestrator.getPlan(created.id);
    expect(restoredPlan.status).toBe("delegated");
    expect(restoredPlan.activeVersion).toBe(1);

    const restoredVersion = second.composition.ceoPlans.orchestrator.getVersion(created.id, 1);
    expect(restoredVersion.contentHash).toBe(v1.contentHash);
    // Recomputing the hash from the restored content — not just comparing
    // the stored hash value — proves no serialization drift survived the
    // SQLite round trip (JSON column re-parse, `delegatedTaskId` merged
    // in at read time from `ceo_delegation_links`, etc.).
    expect(
      computeCeoPlanContentHash({
        objective: restoredVersion.objective,
        summary: restoredVersion.summary,
        assumptions: restoredVersion.assumptions,
        constraints: restoredVersion.constraints,
        steps: restoredVersion.steps.map((step) => ({
          id: step.id,
          position: step.position,
          title: step.title,
          objective: step.objective,
          boundedInstructions: step.boundedInstructions,
          acceptanceCriteria: step.acceptanceCriteria,
          dependencies: step.dependencies,
          ...(step.requirements !== undefined ? { requirements: step.requirements } : {}),
          ...(step.recommendedAdapterId !== undefined
            ? { recommendedAdapterId: step.recommendedAdapterId }
            : {}),
          ...(step.selectedAdapterId !== undefined
            ? { selectedAdapterId: step.selectedAdapterId }
            : {}),
          routingSummary: step.routingSummary,
        })),
      }),
    ).toBe(v1.contentHash);

    const restoredApprovals = second.composition.ceoPlans.orchestrator.listApprovals(created.id);
    expect(restoredApprovals).toHaveLength(1);
    expect(restoredApprovals[0]?.decidedAt).toBe(approval.decidedAt);

    const restoredLinks = second.composition.ceoPlans.orchestrator.listDelegationLinks(created.id);
    expect(restoredLinks).toHaveLength(3);
    for (const link of restoredLinks) {
      expect(second.composition.taskStore.get(link.childTaskId).task.status).toBe("assigned");
    }

    // Phase 14.1 — `getPlanWithProgress` is a pure read: children are
    // still incomplete, so the plan stays `delegated`, and (unlike the
    // old Phase 14 `refreshProgress`) no store write of any kind could
    // ever happen here even in principle — this method has no mutating
    // path left in it at all.
    const { plan: afterRefresh } = second.composition.ceoPlans.orchestrator.getPlanWithProgress(
      created.id,
    );
    expect(afterRefresh.status).toBe("delegated");
    expect(second.composition.ceoPlans.orchestrator.listEvents(created.id)).toHaveLength(
      eventsBeforeRestart.length,
    );
  }, 30000);

  it("once every delegated child task has completed, the startup reconciliation pass (not the first subsequent GET) transitions the plan to completed and appends exactly one terminal event — a second reconciliation is idempotent", async () => {
    const { workspaceRoot, dataDirRaw } = makeTempRoot("hall-ceo-plan-restart-completed-");
    const first = openDurableComposition({ workspaceRoot, dataDirRaw });
    const taskId = createParentTask(first.composition);

    const { plan: created, version: v1 } = await first.composition.ceoPlans.orchestrator.createPlan(
      taskId,
      undefined,
    );
    await first.composition.ceoPlans.orchestrator.submit(
      created.id,
      first.composition.ceoPlans.orchestrator.getMutationToken(created.id),
    );
    await first.composition.ceoPlans.orchestrator.decideApproval(
      created.id,
      first.composition.ceoPlans.orchestrator.getMutationToken(created.id),
      1,
      v1.contentHash,
      "approve",
      undefined,
    );
    const delegateResult = await first.composition.ceoPlans.orchestrator.delegate(
      created.id,
      first.composition.ceoPlans.orchestrator.getMutationToken(created.id),
    );

    // Phase 14.1 — the task-mutation hook now syncs progress in real time
    // as each child completes, which is exactly what makes this scenario
    // (a transition genuinely missed and only caught by startup
    // reconciliation) impossible to reach through the ordinary path: a
    // real crash between a completion write and the hook's own
    // synchronous notification is a true race that can't be reproduced
    // deterministically. Stubbing `onChildTaskMutated` to a no-op for
    // this run simulates exactly that — the notification "fires" (the
    // wrapped `taskStore` still calls it) but never actually performs the
    // sync, precisely as if the process had died between the two.
    const onChildTaskMutatedSpy = vi
      .spyOn(first.composition.ceoPlans.orchestrator, "onChildTaskMutated")
      .mockImplementation(() => {
        /* no-op */
      });

    // Run every child task to completion — sequentially, since a
    // dependent step's dependency is only informational in Phase 14 (no
    // enforced ordering), but running them in order keeps this
    // deterministic and readable.
    for (const childTask of delegateResult.childTasks) {
      const childTaskId = childTask.task.taskId;
      await first.composition.orchestrator.startTask(childTaskId);
      await waitUntil(() => {
        const status = first.composition.taskStore.get(childTaskId).task.status;
        return status === "completed" || status === "failed";
      });
      expect(first.composition.taskStore.get(childTaskId).task.status).toBe("completed");
    }
    onChildTaskMutatedSpy.mockRestore();

    // No sync happened before the crash — the stubbed hook confirms it.
    const eventsBeforeRestart = first.composition.ceoPlans.orchestrator.listEvents(created.id);
    expect(eventsBeforeRestart.some((event) => event.type === "ceo.plan.completed")).toBe(false);
    first.db.close();

    const second = openDurableComposition({ workspaceRoot, dataDirRaw });
    await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: new Date().toISOString(),
      workspaceRoot,
      comparisonRoot: undefined,
      taskStore: second.composition.taskStore,
      taskEventStore: second.composition.eventStore,
      comparison: undefined,
    });

    const restoredPlan = second.composition.ceoPlans.orchestrator.getPlan(created.id);
    expect(restoredPlan.status).toBe("delegated");

    // Phase 14.1 — a pure read (`getPlanWithProgress`) never mutates
    // anything, before or after reconciliation: derived progress already
    // shows every child completed, but the plan's own tracked status
    // does not advance from a GET alone.
    const beforeReconciliation = second.composition.ceoPlans.orchestrator.getPlanWithProgress(
      created.id,
    );
    expect(beforeReconciliation.plan.status).toBe("delegated");
    expect(beforeReconciliation.progress.completed).toBe(3);
    expect(second.composition.ceoPlans.orchestrator.listEvents(created.id)).toHaveLength(
      eventsBeforeRestart.length,
    );

    // Startup reconciliation (what composition wires up once, right
    // after restart recovery — see `reconcileAllPlanProgress`) is what
    // actually performs the transition: exactly one `ceo.plan.completed`
    // event is appended, and the plan's own status advances.
    reconcileAllPlanProgress(second.composition.ceoPlans.orchestrator);

    const { plan: afterReconciliation, progress } =
      second.composition.ceoPlans.orchestrator.getPlanWithProgress(created.id);
    expect(afterReconciliation.status).toBe("completed");
    expect(progress.completed).toBe(3);
    expect(afterReconciliation.completedAt).toBeDefined();

    const eventsAfterReconciliation = second.composition.ceoPlans.orchestrator.listEvents(
      created.id,
    );
    const completedEvents = eventsAfterReconciliation.filter(
      (event) => event.type === "ceo.plan.completed",
    );
    expect(completedEvents).toHaveLength(1);

    // A second reconciliation pass must be a pure, idempotent no-op: no
    // second terminal event, no further mutation. A subsequent read
    // (again, a pure GET) confirms nothing changed either.
    reconcileAllPlanProgress(second.composition.ceoPlans.orchestrator);
    const { plan: afterSecondReconciliation } =
      second.composition.ceoPlans.orchestrator.getPlanWithProgress(created.id);
    expect(afterSecondReconciliation.status).toBe("completed");
    expect(afterSecondReconciliation.completedAt).toBe(afterReconciliation.completedAt);
    const eventsAfterSecondReconciliation = second.composition.ceoPlans.orchestrator.listEvents(
      created.id,
    );
    expect(eventsAfterSecondReconciliation).toHaveLength(eventsAfterReconciliation.length);
  }, 30000);

  it("a draft plan not yet submitted survives a restart unchanged, with revision 0 and no events beyond creation", async () => {
    const { workspaceRoot, dataDirRaw } = makeTempRoot("hall-ceo-plan-restart-draft-");
    const first = openDurableComposition({ workspaceRoot, dataDirRaw });
    const taskId = createParentTask(first.composition);

    const { plan: created } = await first.composition.ceoPlans.orchestrator.createPlan(
      taskId,
      "Focus only on the redirect logic, not the SSO callback itself.",
    );
    expect(created.status).toBe("draft");
    const eventsBeforeRestart = first.composition.ceoPlans.orchestrator.listEvents(created.id);
    first.db.close();

    const second = openDurableComposition({ workspaceRoot, dataDirRaw });
    await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: new Date().toISOString(),
      workspaceRoot,
      comparisonRoot: undefined,
      taskStore: second.composition.taskStore,
      taskEventStore: second.composition.eventStore,
      comparison: undefined,
    });

    // A draft plan is never auto-submitted, auto-approved, or
    // auto-delegated by a restart — it stays exactly `draft`.
    const restoredPlan = second.composition.ceoPlans.orchestrator.getPlan(created.id);
    expect(restoredPlan.status).toBe("draft");
    expect(second.composition.ceoPlans.planStore.getRevision(created.id)).toBe(0);
    expect(second.composition.ceoPlans.orchestrator.listEvents(created.id)).toEqual(
      eventsBeforeRestart,
    );
    expect(second.composition.taskStore.list()).toHaveLength(1);
  }, 30000);
});
