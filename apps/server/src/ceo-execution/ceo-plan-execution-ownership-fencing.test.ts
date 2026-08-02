import { describe, expect, it } from "vitest";
import { DEFAULT_CEO_PLAN_EXECUTION_POLICY } from "@hall-of-wisdom/protocol";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { acquireDatabaseEpoch } from "../persistence/database-ownership-fence.js";
import { OwnershipLostError } from "../persistence/persistence-errors.js";
import { SqliteCeoPlanRunStore } from "./sqlite-ceo-plan-run-store.js";
import { SqliteExecutionSignalStore } from "./sqlite-execution-signal-store.js";

const NOW = "2026-07-31T12:00:00.000Z";
const RUN_ID = "run-fencing-1";
const PLAN_ID = "plan-fencing-1";
const STEP_ID = "step-a";
const CHILD_TASK_ID = "task-a";

function emptyDependencySummary() {
  return {
    totalDependencies: 0,
    completedDependencies: 0,
    failedDependencies: 0,
    cancelledDependencies: 0,
  };
}

/**
 * Kickoff §5 — execution-specific ownership-fencing tests. `transaction.test.ts`
 * already proves the CORE guarantee generically, once, at the exact
 * boundary every repository shares (`withTransaction` itself): a fenced
 * transaction whose `db.ownershipFence` no longer matches the current
 * `durable_ownership` row throws `OwnershipLostError`, rolls back, and
 * never lets execution reach code after it. What this file adds is
 * confirmation that every execution-specific WRITE OPERATION the
 * scheduler actually performs — not a synthetic table — genuinely routes
 * through that same boundary, by calling each one directly against a
 * `SqliteCeoPlanRunStore`/`SqliteExecutionSignalStore` pair whose
 * `db.ownershipFence` was captured before a second instance took over.
 * This is deliberately exercised at the store layer (never through
 * `CeoPlanExecutionScheduler` itself, which has no raw-SQL code path of
 * its own — see this store's/that scheduler's own source — and always
 * delegates to exactly these methods), the same choice
 * `transaction.test.ts` makes for its own generic boundary proof.
 *
 * "Instance A" and "instance B" share one physical `HallDatabase`
 * connection here — as `transaction.test.ts` notes, this is a test-only
 * convenience; in production they are two separate processes against the
 * same on-disk file. What matters for this proof is that instance A's
 * store objects keep the STALE `OwnershipFence` object they were built
 * with (production wiring calls `db.setOwnershipFence` exactly once at
 * startup, never re-reads it), which is exactly what "frozen" means here.
 *
 * "Instance A cannot overwrite or remove B's lock" (kickoff §5) is
 * proven at the correct layer elsewhere, not re-derived here:
 * `acquireDatabaseEpoch` is intentionally always-successful for whoever
 * calls it (that is what makes a legitimate restart reacquisition work),
 * so a bare epoch-level "A can't overwrite" assertion would misrepresent
 * the design. The actual non-overwritable resource is the filesystem
 * ownership lock checked before any database epoch is ever acquired —
 * see `persistence/instance-ownership.test.ts`, "release() never removes
 * a lock a later instance has since taken over."
 */
describe("CEO plan execution — frozen-owner fencing (kickoff §5)", () => {
  function buildFrozenHarness() {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    const fenceA = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(fenceA);

    const runStore = new SqliteCeoPlanRunStore({ db });
    const signalStore = new SqliteExecutionSignalStore({ db });

    runStore.configureRun({
      runId: RUN_ID,
      planId: PLAN_ID,
      planVersion: 1,
      executionMode: "autonomous",
      policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      now: NOW,
      steps: [{ stepId: STEP_ID, childTaskId: CHILD_TASK_ID, dependencyStepIds: [] }],
    });
    runStore.startRun({ runId: RUN_ID, now: NOW });
    const { attempt } = runStore.claimAttempt({
      attemptId: "attempt-1",
      runId: RUN_ID,
      planStepId: STEP_ID,
      childTaskId: CHILD_TASK_ID,
      attemptNumber: 1,
      triggerReason: "execution_started",
      schedulerSignalId: "signal-seed",
      leaseGeneration: 1,
      ownerToken: "owner-a",
      now: NOW,
      readinessReason: "ready",
      dependencySummary: emptyDependencySummary(),
    });
    const enqueueResult = signalStore.enqueue({
      signalId: "signal-baseline",
      planRunId: RUN_ID,
      planStepId: undefined,
      generation: 1,
      reason: "execution_started",
      priority: "normal",
      availableAt: NOW,
      now: NOW,
    });

    // Instance B takes over — a strictly greater epoch is recorded, but
    // `db.ownershipFence` (still `fenceA`) is deliberately never updated,
    // exactly matching a real frozen process that never re-reads it.
    const fenceB = acquireDatabaseEpoch(db, "owner-b");

    return { db, runStore, signalStore, fenceA, fenceB, seedAttemptId: attempt.id, enqueueResult };
  }

  const operations: readonly {
    readonly name: string;
    readonly run: (h: ReturnType<typeof buildFrozenHarness>) => void;
  }[] = [
    {
      name: "configure a plan run",
      run: (h) =>
        h.runStore.configureRun({
          runId: "run-fencing-configure",
          planId: PLAN_ID,
          planVersion: 1,
          executionMode: "autonomous",
          policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
          now: NOW,
          steps: [{ stepId: "step-x", childTaskId: "task-x", dependencyStepIds: [] }],
        }),
    },
    {
      name: "start a plan run",
      run: (h) => h.runStore.startRun({ runId: RUN_ID, now: NOW }),
    },
    {
      name: "insert or coalesce a signal",
      run: (h) =>
        h.signalStore.enqueue({
          signalId: "signal-new",
          planRunId: RUN_ID,
          planStepId: STEP_ID,
          generation: 1,
          reason: "adapter_availability_changed",
          priority: "normal",
          availableAt: NOW,
          now: NOW,
        }),
    },
    {
      name: "claim a signal",
      run: (h) =>
        h.signalStore.claimNext({
          now: NOW,
          ownerToken: "owner-a",
          leaseSeconds: 30,
          eligibleRunIds: [RUN_ID],
        }),
    },
    {
      name: "create an attempt",
      run: (h) =>
        h.runStore.createAttempt({
          attemptId: "attempt-frozen",
          runId: RUN_ID,
          planStepId: STEP_ID,
          childTaskId: CHILD_TASK_ID,
          attemptNumber: 2,
          triggerReason: "retry_due",
          schedulerSignalId: "signal-baseline",
          leaseGeneration: 1,
          ownerToken: "owner-a",
          now: NOW,
        }),
    },
    {
      name: "update step runtime",
      run: (h) =>
        h.runStore.upsertStepExecution({
          runId: RUN_ID,
          planStepId: STEP_ID,
          status: "running",
          readinessReason: "ready",
          dependencySummary: emptyDependencySummary(),
          startedAt: NOW,
        }),
    },
    {
      name: "schedule a retry",
      run: (h) =>
        h.runStore.upsertStepExecution({
          runId: RUN_ID,
          planStepId: STEP_ID,
          status: "retry_wait",
          readinessReason: "ready",
          dependencySummary: emptyDependencySummary(),
          nextEligibleAt: NOW,
        }),
    },
    {
      name: "open the circuit breaker",
      run: (h) => {
        h.runStore.tripCircuit({
          runId: RUN_ID,
          reason: "consecutive_failures",
          stepId: STEP_ID,
          now: NOW,
        });
      },
    },
    {
      name: "pause",
      run: (h) => h.runStore.pauseRun({ runId: RUN_ID, now: NOW }),
    },
    {
      name: "resume",
      run: (h) => h.runStore.resumeRun({ runId: RUN_ID, now: NOW }),
    },
    {
      name: "cancel",
      run: (h) => h.runStore.cancelRun({ runId: RUN_ID, now: NOW }),
    },
    {
      name: "append an execution event",
      run: (h) =>
        h.runStore.appendEvent({
          runId: RUN_ID,
          type: "ceo.execution.step_started",
          actor: "system:ceo-scheduler",
          payload: { planStepId: STEP_ID },
          now: NOW,
        }),
    },
    {
      name: "append an intervention",
      run: (h) => {
        h.runStore.recordIntervention({
          interventionId: "intervention-frozen",
          runId: RUN_ID,
          type: "pause",
          note: undefined,
          now: NOW,
        });
      },
    },
    {
      name: "post a scheduler Board message (dedup claim)",
      run: (h) => h.runStore.claimBoardAuditOnce(RUN_ID, "frozen-owner-dedup-key", NOW),
    },
  ];

  it.each(operations)("frozen instance A cannot $name — throws OwnershipLostError", ({ run }) => {
    const harness = buildFrozenHarness();
    expect(() => {
      run(harness);
    }).toThrow(OwnershipLostError);
    harness.db.close();
  });

  it("none of the 14 rejected operations changed the run's projected state, step execution, event log, or signal queue", () => {
    const harness = buildFrozenHarness();
    const runBefore = harness.runStore.findRun(RUN_ID);
    const stepBefore = harness.runStore.getStepExecution(RUN_ID, STEP_ID);
    const eventsBefore = harness.runStore.listEvents(RUN_ID);
    const attemptsBefore = harness.runStore.listAttempts(RUN_ID);
    const signalsBefore = harness.signalStore.listSignalsForRun(RUN_ID);

    for (const operation of operations) {
      expect(() => {
        operation.run(harness);
      }).toThrow(OwnershipLostError);
    }

    expect(harness.runStore.findRun(RUN_ID)).toEqual(runBefore);
    expect(harness.runStore.getStepExecution(RUN_ID, STEP_ID)).toEqual(stepBefore);
    expect(harness.runStore.listEvents(RUN_ID)).toEqual(eventsBefore);
    expect(harness.runStore.listAttempts(RUN_ID)).toEqual(attemptsBefore);
    expect(harness.signalStore.listSignalsForRun(RUN_ID)).toEqual(signalsBefore);
    harness.db.close();
  });

  it("the Board-audit dedup key is never consumed by a rejected attempt — the legitimate new owner can still claim it", () => {
    const harness = buildFrozenHarness();
    expect(() => {
      harness.runStore.claimBoardAuditOnce(RUN_ID, "shared-dedup-key", NOW);
    }).toThrow(OwnershipLostError);

    // Instance B, using its own (valid) fence on the same connection —
    // the same test-only simplification `transaction.test.ts` uses.
    harness.db.setOwnershipFence(harness.fenceB);
    expect(harness.runStore.claimBoardAuditOnce(RUN_ID, "shared-dedup-key", NOW)).toBe(true);
    harness.db.close();
  });

  it("instance B remains healthy and can keep mutating normally after every one of A's attempts was rejected", () => {
    const harness = buildFrozenHarness();
    for (const operation of operations) {
      expect(() => {
        operation.run(harness);
      }).toThrow(OwnershipLostError);
    }

    harness.db.setOwnershipFence(harness.fenceB);
    expect(() => {
      harness.runStore.pauseRun({ runId: RUN_ID, now: NOW });
    }).not.toThrow();
    expect(harness.runStore.findRun(RUN_ID)?.status).toBe("paused");
    harness.db.close();
  });

  it("no scheduler event ever publishes for a rejected mutation — appendEvent itself throws before returning an event to publish", () => {
    // `#appendEvent`'s own doc comment (`ceo-plan-execution-scheduler.ts`)
    // guarantees `eventBus.publish` is only ever called with the return
    // value of a successful `planRunStore.appendEvent` call, strictly
    // after it returns. If the store write itself throws
    // `OwnershipLostError` (proven above), there is no event object for
    // any caller to publish — this is a structural guarantee, not a
    // separate code path to race.
    const harness = buildFrozenHarness();
    let published: unknown;
    expect(() => {
      const event = harness.runStore.appendEvent({
        runId: RUN_ID,
        type: "ceo.execution.step_completed",
        actor: "system:ceo-scheduler",
        payload: { planStepId: STEP_ID },
        now: NOW,
      });
      // Unreachable once the fence rejects — mirrors every real call site,
      // where publish always happens on the statement immediately after.
      published = event;
    }).toThrow(OwnershipLostError);
    expect(published).toBeUndefined();
    harness.db.close();
  });
});
