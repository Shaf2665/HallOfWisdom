import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  parseAgentAdapterDescriptor,
  type AgentAdapter,
  type AgentAdapterDescriptor,
  type AgentDetectionResult,
} from "@hall-of-wisdom/agent-adapter-sdk";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
import {
  DEFAULT_CEO_PLAN_EXECUTION_POLICY,
  type CeoPlanExecutionPolicy,
} from "@hall-of-wisdom/protocol";
import { TaskStore } from "./task-store.js";
import { SqliteTaskStore } from "./sqlite-task-store.js";
import { TaskOrchestrator } from "./task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { acquireDatabaseEpoch } from "../persistence/database-ownership-fence.js";
import { OwnershipLostError } from "../persistence/persistence-errors.js";
import { createEphemeralAtomicUnit } from "../ceo-plans/ephemeral-atomic-unit.js";
import { InMemoryCeoPlanRunStore } from "../ceo-execution/in-memory-ceo-plan-run-store.js";
import { InMemoryExecutionSignalStore } from "../ceo-execution/in-memory-execution-signal-store.js";
import { CeoPlanExecutionScheduler } from "../ceo-execution/ceo-plan-execution-scheduler.js";

/**
 * The two launch-time-TOCTOU scenarios that need a materially different
 * harness from `task-orchestrator-launch-toctou.test.ts`'s shared
 * `buildRaceHarness`:
 *
 * - Scenario 13: proves `CeoPlanExecutionScheduler#tryAdvanceStep` (the
 *   autonomous execution entry point) launches through the exact same
 *   `TaskOrchestrator.startTask()` — and therefore the same
 *   `startIfEligible` guard — as the manual `/start` route proven in the
 *   sibling file's scenario 12, not a bypass or a second, weaker check.
 * - Scenario 16: proves a frozen/stale DURABLE owner (Phase 13.2's
 *   ownership-fencing model) cannot complete `startIfEligible`'s commit
 *   even when the task itself never changed — the SQLite-backed sibling
 *   of the in-memory scenarios, and the only one where the rejection
 *   comes from the persistence layer's own fence rather than the
 *   store's revision/four-field compare.
 */

const BASE_NOW = "2026-07-31T12:00:00.000Z";

interface BarrierAdapterController {
  readonly parkedCount: number;
  readonly startTaskCallCount: number;
  waitForParked(count: number, timeoutMs?: number): Promise<void>;
  release(): void;
}

/**
 * A minimal barrier adapter for this file — deliberately not imported
 * from the sibling test file (each Hall Core test file that needs a
 * gated/barrier adapter builds its own small local copy; see
 * `routes/routing.test.ts`'s own `createRoutingGatedAdapter` next to
 * `test-support.ts`'s shared `createGatedAdapter`). `release()` here
 * only needs to control availability/trust — no per-scenario
 * capability-observation shaping is needed in this file, unlike the
 * sibling file's scenarios 3/4/14/15.
 */
function createBarrierAdapter(adapterId: string): {
  adapter: AgentAdapter;
  controller: BarrierAdapterController;
} {
  const delegate = new MockAgentAdapter({ scenario: "success", stepDelayMs: 0 });
  const descriptor: AgentAdapterDescriptor = parseAgentAdapterDescriptor({
    ...delegate.descriptor,
    adapterId,
    displayName: "Barrier Entry-Point Test Agent",
    supportedAgent: {
      ...delegate.descriptor.supportedAgent,
      adapterId,
      agentId: adapterId,
      displayName: "Barrier Entry-Point Test Agent",
    },
  });

  let parked = 0;
  let releasers: ((result: AgentDetectionResult) => void)[] = [];
  let startTaskCallCount = 0;

  const controller: BarrierAdapterController = {
    get parkedCount() {
      return parked;
    },
    get startTaskCallCount() {
      return startTaskCallCount;
    },
    async waitForParked(count, timeoutMs = 2000) {
      const start = Date.now();
      while (parked < count) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `BarrierAdapterController.waitForParked: only ${String(parked)}/${String(count)} detect() calls parked within ${String(timeoutMs)}ms`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    release() {
      const toRelease = releasers;
      releasers = [];
      parked -= toRelease.length;
      for (const resolve of toRelease) {
        resolve({
          installed: true,
          availability: "available",
          executionTrust: "isolated",
          capabilityObservations: [],
        });
      }
    },
  };

  const adapter: AgentAdapter = {
    descriptor,
    detect(): Promise<AgentDetectionResult> {
      parked += 1;
      return new Promise((resolve) => {
        releasers.push(resolve);
      });
    },
    startTask(input, options) {
      startTaskCallCount += 1;
      return delegate.startTask(input, options);
    },
  };

  return { adapter, controller };
}

describe("Scenario 13 — CeoPlanExecutionScheduler launches through the SAME startTask() guard as the manual entry point", () => {
  function buildSchedulerHarness(adapter: AgentAdapter) {
    let currentNow = BASE_NOW;
    const registry = new AgentRegistry();
    registry.register(adapter);
    const taskStore = new TaskStore({ maxTasks: 100 });
    const eventStore = new EventStore({ maxEventsPerTask: 1000 });
    const eventBus = new EventBus({ maxSubscribersPerTask: 20 });
    const taskOrchestrator = new TaskOrchestrator({
      taskStore,
      eventStore,
      eventBus,
      registry,
      workspaceRoot: process.cwd(),
    });
    const planRunStore = new InMemoryCeoPlanRunStore();
    const signalStore = new InMemoryExecutionSignalStore();
    const boardAuditLog: string[] = [];
    const scheduler = new CeoPlanExecutionScheduler({
      planRunStore,
      signalStore,
      taskStore,
      taskOrchestrator,
      now: () => currentNow,
      ownerToken: "owner-1",
      leaseSeconds: 30,
      postBoardAudit: (_planId, text) => boardAuditLog.push(text),
      runAtomicUnit: createEphemeralAtomicUnit({ planRunStore, signalStore }),
    });
    return {
      taskStore,
      taskOrchestrator,
      planRunStore,
      signalStore,
      scheduler,
      boardAuditLog,
      now: () => currentNow,
      advanceTime: (seconds: number) => {
        currentNow = new Date(new Date(currentNow).getTime() + seconds * 1000).toISOString();
      },
    };
  }

  function addAssignedTask(
    taskStore: TaskStore,
    input: { readonly taskId: string; readonly adapterId: string },
  ): void {
    taskStore.add({
      task: {
        taskId: input.taskId,
        projectId: "project-1",
        title: `Task ${input.taskId}`,
        description: "A step delegated by a CEO plan.",
        priority: "normal",
        status: "assigned",
        dependencyTaskIds: [],
        createdAt: BASE_NOW,
        updatedAt: BASE_NOW,
        requirements: { requiredCapabilities: [], allowedExecutionTrust: ["isolated"] },
      },
      runId: undefined,
      adapterId: input.adapterId,
      agentId: input.adapterId,
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: BASE_NOW,
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: "isolated",
    });
  }

  function configureAndStart(
    harness: ReturnType<typeof buildSchedulerHarness>,
    runId: string,
    planId: string,
    stepId: string,
    childTaskId: string,
    policyOverrides: Partial<CeoPlanExecutionPolicy> = {},
  ) {
    const policy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      ...policyOverrides,
    };
    harness.planRunStore.configureRun({
      runId,
      planId,
      planVersion: 1,
      executionMode: "autonomous",
      policy,
      now: harness.now(),
      steps: [{ stepId, childTaskId, dependencyStepIds: [] }],
    });
    harness.scheduler.registerDependencyIndex(runId, [{ id: stepId, dependencies: [] }]);
    return harness.planRunStore.startRun({ runId, now: harness.now() });
  }

  it("13. the scheduler's launch call is TaskOrchestrator.startTask() itself, rejected the identical way a manual /start would be — one attempt claimed, zero adapter.startTask() calls, safe classification", async () => {
    // `#tryAdvanceStep` (`ceo-plan-execution-scheduler.ts`, ~line 746)
    // reads `await this.#taskOrchestrator.startTask(step.childTaskId)` —
    // literally the same method instance the manual `/start` route calls
    // (see the sibling file's scenario 12) — there is no second,
    // scheduler-specific eligibility implementation anywhere in this
    // codebase to duplicate.
    const runId = "run-toctou-13";
    const planId = "plan-toctou-13";
    const stepId = "step-a";
    const childTaskId = "task-toctou-13-child";
    const barrier = createBarrierAdapter("hall.scheduler-barrier-agent");
    const harness = buildSchedulerHarness(barrier.adapter);
    addAssignedTask(harness.taskStore, {
      taskId: childTaskId,
      adapterId: "hall.scheduler-barrier-agent",
    });
    configureAndStart(harness, runId, planId, stepId, childTaskId);

    const firstSignal = harness.scheduler.enqueueSignal({
      planRunId: runId,
      reason: "execution_started",
    });
    await barrier.controller.waitForParked(1);

    // The exact same TOCTOU mutation as the sibling file's scenario 6
    // (task status changes while detect() is pending) — proves the
    // scheduler's launch is subject to the identical guard, not a
    // bypass.
    harness.taskStore.updateStatus(childTaskId, "blocked");

    // A second signal for the SAME run, issued and fully drained WHILE
    // the first is still parked mid-launch: `#tryAdvanceStep`'s own
    // early-return (`["claimed", "starting", ...].includes(step.status)`)
    // means this resolves immediately without itself reaching
    // `detect()` — the step was already moved to `"claimed"` by the
    // first signal's `claimAttempt`, synchronously, before its `await
    // startTask()` — so this deterministically proves "no duplicate
    // scheduler attempt" without racing two concurrent launches against
    // each other.
    await harness.scheduler.enqueueSignal({ planRunId: runId, reason: "operator_resumed" });

    barrier.controller.release();
    await firstSignal;

    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(barrier.controller.parkedCount).toBe(0);
    const attempts = harness.planRunStore.listAttempts(runId, stepId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("failed");
    // Safe classification, not a raw error/stack — `startTask()`'s
    // `TaskStateConflictError` is bucketed as `requirements_changed`
    // (`#handleStartFailure`) and never automatically retried.
    expect(attempts[0]?.safeFailureCode).toBe("requirements_changed");
    expect(attempts[0]?.safeFailureSummary).toBe(
      `Task "${childTaskId}" cannot be started while in status "blocked".`,
    );
    const step = harness.planRunStore.getStepExecution(runId, stepId);
    expect(step.status).toBe("awaiting_intervention");
    expect(harness.taskStore.get(childTaskId).task.status).toBe("blocked");
    expect(harness.taskStore.get(childTaskId).runId).toBeUndefined();
  });
});

describe("Scenario 16 — a frozen/stale durable owner cannot complete startIfEligible", () => {
  it("16. instance A's cached ownership fence is superseded by instance B before A's parked launch resumes — startIfEligible's fenced commit throws OwnershipLostError, never TaskStateConflictError, and nothing is written", async () => {
    // Mirrors `ceo-execution/ceo-plan-execution-ownership-fencing.test.ts`'s
    // established frozen-owner pattern (see that file's own doc comment
    // for why sharing one physical connection across "instance A" and
    // "instance B" is a faithful test-only simplification of two real
    // processes against the same on-disk file): instance A's
    // `SqliteTaskStore`/`db.ownershipFence` object is never updated after
    // B takes over — "frozen" means exactly that A keeps using its own,
    // now-superseded, `OwnershipFence` value, precisely like a real
    // process that never re-reads it.
    //
    // Deliberately does NOT also mutate the task's own state (unlike
    // scenarios 6/7/8/9/10 in the sibling file): `SqliteTaskStore.
    // startIfEligible()`'s revision/four-field compare runs BEFORE it
    // ever enters `withTransaction` (see that method's own body), so a
    // task-state drift would make this test prove only the ordinary
    // revision guard again, never reaching the fence at all. The task
    // here is untouched and fully eligible right up to the atomic
    // commit — only the durable ownership epoch moves — so the ONLY
    // thing that can reject this launch is the fence itself.
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    const taskId = "task-toctou-16-frozen-owner";
    const taskStore = new SqliteTaskStore({ db, maxTasks: 100 });
    const barrier = createBarrierAdapter("hall.frozen-owner-barrier-agent");

    // Instance A acquires ownership, then adds the task under its own
    // valid fence.
    const fenceA = acquireDatabaseEpoch(db, "owner-a");
    db.setOwnershipFence(fenceA);
    taskStore.add({
      task: {
        taskId,
        projectId: "project-1",
        title: "Frozen-owner launch fixture",
        description: "A task started against a soon-to-be-superseded durable owner.",
        priority: "normal",
        status: "assigned",
        dependencyTaskIds: [],
        createdAt: BASE_NOW,
        updatedAt: BASE_NOW,
      },
      runId: undefined,
      adapterId: "hall.frozen-owner-barrier-agent",
      agentId: "hall.frozen-owner-barrier-agent",
      eventCount: 0,
      lastSequence: undefined,
      terminalEventType: undefined,
      failure: undefined,
      cancellationRequested: false,
      createdAt: BASE_NOW,
      startedAt: undefined,
      completedAt: undefined,
      assignedExecutionTrust: "isolated",
    });

    const registry = new AgentRegistry();
    registry.register(barrier.adapter);
    const eventStore = new EventStore({ maxEventsPerTask: 1000 });
    const eventBus = new EventBus({ maxSubscribersPerTask: 20 });
    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore,
      eventBus,
      registry,
      workspaceRoot: process.cwd(),
    });

    const settled = orchestrator.startTask(taskId).then(
      (result) => ({ ok: result }) as const,
      (error: unknown) => ({ err: error }) as const,
    );
    await barrier.controller.waitForParked(1);

    // Instance B takes over — `db`'s `durable_ownership` row now records
    // B's token/epoch, but `db.ownershipFence` (still `fenceA`, since
    // nothing here ever calls `db.setOwnershipFence(fenceB)`) is
    // deliberately left stale, exactly matching a real frozen process.
    acquireDatabaseEpoch(db, "owner-b");

    barrier.controller.release();
    const outcome = await settled;

    if (!("err" in outcome)) {
      throw new Error(
        `expected startTask() to reject, but it resolved: ${JSON.stringify(outcome)}`,
      );
    }
    expect(outcome.err).toBeInstanceOf(OwnershipLostError);
    expect((outcome.err as Error).message).toBe(
      "This instance's durable ownership epoch has been superseded by another instance; the mutation was rolled back.",
    );
    // Bounded and safe: no raw revision number, database path, or
    // owner-token/epoch value in the message.
    expect((outcome.err as Error).message).not.toContain("owner-a");
    expect((outcome.err as Error).message).not.toContain("owner-b");

    expect(barrier.controller.startTaskCallCount).toBe(0);
    expect(eventStore.list(taskId)).toHaveLength(0);
    // Nothing was written: the task is exactly as it was before the
    // rejected commit attempted anything.
    const record = taskStore.get(taskId);
    expect(record.task.status).toBe("assigned");
    expect(record.runId).toBeUndefined();
    expect(record.lastSequence).toBeUndefined();

    db.close();
  });
});
