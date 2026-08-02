import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
import type { AgentAdapter } from "@hall-of-wisdom/agent-adapter-sdk";
import {
  DEFAULT_CEO_PLAN_EXECUTION_POLICY,
  type CeoPlanExecutionPolicy,
} from "@hall-of-wisdom/protocol";
import { TaskStore } from "../tasks/task-store.js";
import { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import { waitUntil } from "../test-support.js";
import { createEphemeralAtomicUnit } from "../ceo-plans/ephemeral-atomic-unit.js";
import { reconcileTasks, RESTART_INTERRUPTED_RUN_CODE } from "../recovery/reconcile-tasks.js";
import { CeoPlanExecutionAbandonedRetryNotEligibleError } from "../errors/app-error.js";
import { InMemoryCeoPlanRunStore } from "./in-memory-ceo-plan-run-store.js";
import { InMemoryExecutionSignalStore } from "./in-memory-execution-signal-store.js";
import { CeoPlanExecutionScheduler } from "./ceo-plan-execution-scheduler.js";

/**
 * Phase 15.6 — `CeoPlanExecutionScheduler.retryAbandonedStep()`, the one
 * narrow, explicit-operator-only path that can relaunch a step abandoned
 * by unclean-restart recovery. Mirrors `ceo-plan-execution-scheduler.test.ts`'s
 * own harness (real `TaskStore`/`TaskOrchestrator`/`AgentRegistry`, never a
 * mocked orchestrator) so every launch this file drives goes through the
 * exact same `TaskOrchestrator.startTask()` path production uses.
 *
 * Deliberately does NOT simulate a genuine cross-process restart (a fresh
 * scheduler instance with an empty dependency-index map) — that is
 * `ceo-plan-execution-durable-restart.test.ts`'s job, using the real
 * composition root across a genuine `HallDatabase` close/reopen, which is
 * the only way to prove the `/resume` route's dependency-index rebuild is
 * load-bearing. This file isolates `retryAbandonedStep`'s own guard logic
 * from that concern by never dropping the index in the first place.
 */

const WORKSPACE_ROOT = process.cwd();
const NOW = "2026-07-31T12:00:00.000Z";

function buildHarness(options: { adapter?: AgentAdapter; boardAuditLog?: string[] } = {}) {
  const registry = new AgentRegistry();
  registry.register(
    options.adapter ?? new MockAgentAdapter({ scenario: "success", stepDelayMs: 0 }),
  );
  const taskStore = new TaskStore({ maxTasks: 100 });
  const eventStore = new EventStore({ maxEventsPerTask: 1000 });
  const eventBus = new EventBus({ maxSubscribersPerTask: 20 });
  const taskOrchestrator = new TaskOrchestrator({
    taskStore,
    eventStore,
    eventBus,
    registry,
    workspaceRoot: WORKSPACE_ROOT,
  });
  const planRunStore = new InMemoryCeoPlanRunStore();
  const signalStore = new InMemoryExecutionSignalStore();
  const boardAuditLog = options.boardAuditLog ?? [];
  const scheduler = new CeoPlanExecutionScheduler({
    planRunStore,
    signalStore,
    taskStore,
    taskOrchestrator,
    now: () => NOW,
    ownerToken: "owner-1",
    leaseSeconds: 30,
    postBoardAudit: (_planId, text) => boardAuditLog.push(text),
    runAtomicUnit: createEphemeralAtomicUnit({ planRunStore, signalStore }),
  });
  return {
    taskStore,
    eventStore,
    taskOrchestrator,
    planRunStore,
    signalStore,
    scheduler,
    boardAuditLog,
  };
}

function addAssignedTask(
  taskStore: TaskStore,
  input: { taskId: string; adapterId?: string; dependencyTaskIds?: string[] },
): void {
  taskStore.add({
    task: {
      taskId: input.taskId,
      projectId: "project-1",
      title: `Task ${input.taskId}`,
      description: "A step delegated by a CEO plan.",
      priority: "normal",
      status: "assigned",
      dependencyTaskIds: input.dependencyTaskIds ?? [],
      createdAt: NOW,
      updatedAt: NOW,
      requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
    },
    runId: undefined,
    adapterId: input.adapterId ?? "hall.mock-agent",
    agentId: "mock-agent",
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: NOW,
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: "simulated",
  });
}

interface StepSpec {
  readonly stepId: string;
  readonly childTaskId: string;
  readonly dependencyStepIds?: readonly string[];
}

function configureAndStart(
  harness: ReturnType<typeof buildHarness>,
  runId: string,
  planId: string,
  steps: readonly StepSpec[],
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
    now: NOW,
    steps: steps.map((s) => ({
      stepId: s.stepId,
      childTaskId: s.childTaskId,
      dependencyStepIds: s.dependencyStepIds ?? [],
    })),
  });
  harness.scheduler.registerDependencyIndex(
    runId,
    steps.map((s) => ({ id: s.stepId, dependencies: s.dependencyStepIds ?? [] })),
  );
  return harness.planRunStore.startRun({ runId, now: NOW });
}

/**
 * Drives one step to a genuine unclean-restart-abandoned state: the child
 * task is really `running` (a real in-flight `TaskOrchestrator.startTask()`
 * call against the `"cancellable"` Mock Agent scenario, never a synthetic
 * status write), then applies the REAL `reconcileTasks()` (the exact
 * function `runRestartRecovery` calls on every durable boot) to mark it
 * `"failed"` with `HALL_RESTART_INTERRUPTED_RUN` — never a hand-rolled
 * failure code. The attempt/step/run side of unclean-restart recovery
 * (`ceo-plan-execution-recovery.ts`'s unclean-restart branch) is then
 * replayed here using the exact same store-level primitive calls that
 * function itself uses, so the resulting state is byte-for-byte what a
 * real crash would leave — this file isolates the SCHEDULER's own guard
 * logic, not the recovery pipeline (already covered elsewhere).
 */
async function abandonRunningStep(
  harness: ReturnType<typeof buildHarness>,
  runId: string,
  stepId: string,
  taskId: string,
): Promise<{ abandonedAttemptId: string; previousTaskRunId: string | undefined }> {
  await waitUntil(() => harness.taskStore.get(taskId).runId !== undefined);
  const beforeCrash = harness.taskStore.get(taskId);
  const previousTaskRunId = beforeCrash.runId;

  reconcileTasks(harness.taskStore, harness.eventStore);
  const afterReconcile = harness.taskStore.get(taskId);
  expect(afterReconcile.task.status).toBe("failed");
  expect(afterReconcile.failure?.code).toBe(RESTART_INTERRUPTED_RUN_CODE);

  const stepBefore = harness.planRunStore.getStepExecution(runId, stepId);
  const activeAttemptId = stepBefore.activeAttemptId;
  if (activeAttemptId === undefined) throw new Error("expected an active attempt to abandon");
  harness.planRunStore.updateAttempt({ attemptId: activeAttemptId, status: "abandoned", now: NOW });
  harness.planRunStore.upsertStepExecution({
    runId,
    planStepId: stepId,
    status: "awaiting_intervention",
    readinessReason: "operator_intervention",
    dependencySummary: stepBefore.dependencySummary,
  });
  harness.planRunStore.recoveryPauseRun({ runId, now: NOW, classification: "unclean_paused" });
  return { abandonedAttemptId: activeAttemptId, previousTaskRunId };
}

function cancellableHarness(boardAuditLog?: string[]) {
  return buildHarness({
    adapter: new MockAgentAdapter({ scenario: "cancellable", stepDelayMs: 5000 }),
    ...(boardAuditLog ? { boardAuditLog } : {}),
  });
}

describe("CeoPlanExecutionScheduler.retryAbandonedStep (Phase 15.6)", () => {
  it("Resume alone starts nothing — no new attempt, no new task run", async () => {
    const harness = cancellableHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await abandonRunningStep(harness, "run-1", "step-a", "task-a");

    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "operator_resumed" });

    expect(harness.planRunStore.listAttempts("run-1", "step-a")).toHaveLength(1);
    expect(harness.taskStore.get("task-a").task.status).toBe("failed");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe(
      "awaiting_intervention",
    );
  });

  it("Retry before Resume is rejected — the run must be 'running' first", async () => {
    const harness = cancellableHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await abandonRunningStep(harness, "run-1", "step-a", "task-a");

    expect(harness.planRunStore.getRun("run-1").status).toBe("awaiting_intervention");
    await expect(harness.scheduler.retryAbandonedStep("run-1", "step-a")).rejects.toThrow(
      CeoPlanExecutionAbandonedRetryNotEligibleError,
    );
    expect(harness.planRunStore.listAttempts("run-1", "step-a")).toHaveLength(1);
  });

  it("Resume followed by Retry creates attempt 2 with a new task-run ID, preserving the abandoned attempt", async () => {
    // "cancellable" (not "success") — the original in-process
    // `MockAgentAdapter` execution behind attempt 1 keeps running in the
    // background even after this test's own `reconcileTasks()` call
    // simulates the crash (a genuine OS-process crash would actually stop
    // it; this in-process harness cannot). A fast-completing scenario
    // would let attempt 1's own stray completion event arrive AFTER
    // attempt 2 has already been prepared, corrupting the assertions
    // below — "cancellable"'s long delay guarantees it never fires within
    // this test's lifetime.
    const harness = cancellableHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      maxAttemptsPerStep: 2,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    const { abandonedAttemptId, previousTaskRunId } = await abandonRunningStep(
      harness,
      "run-1",
      "step-a",
      "task-a",
    );

    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });
    await harness.scheduler.retryAbandonedStep("run-1", "step-a");

    const attempts = harness.planRunStore.listAttempts("run-1", "step-a");
    expect(attempts).toHaveLength(2);
    const [attempt1, attempt2] = attempts;
    // Abandoned attempt 1 is untouched — never mutated by the recovery.
    expect(attempt1?.id).toBe(abandonedAttemptId);
    expect(attempt1?.status).toBe("abandoned");
    expect(attempt1?.taskRunId).toBe(previousTaskRunId);
    // Attempt 2 is genuinely new, with a new task-run ID.
    expect(attempt2?.id).not.toBe(abandonedAttemptId);
    expect(attempt2?.taskRunId).toBeDefined();
    expect(attempt2?.taskRunId).not.toBe(previousTaskRunId);
    expect(harness.taskStore.get("task-a").runId).toBeDefined();
    expect(harness.taskStore.get("task-a").runId).not.toBe(previousTaskRunId);
  });

  it("event sequence stays cumulative across the abandoned attempt and the replacement — never reset to 0", async () => {
    const harness = cancellableHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      maxAttemptsPerStep: 2,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await abandonRunningStep(harness, "run-1", "step-a", "task-a");
    const beforeRetry = harness.eventStore.list("task-a");
    const lastSequenceBeforeRetry = beforeRetry.at(-1)?.sequence ?? -1;

    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });
    await harness.scheduler.retryAbandonedStep("run-1", "step-a");
    // Attempt 2's own launch (`run.started`) is appended synchronously as
    // part of `startTask()`, well before the "cancellable" scenario's own
    // long-delayed completion — no need to wait for full completion here,
    // only for the new run's own first event to land.
    await waitUntil(() => harness.eventStore.list("task-a").length > beforeRetry.length);

    const after = harness.eventStore.list("task-a");
    // Strictly increasing, never reset — attempt 2's own events start
    // exactly where attempt 1's interrupted-run event left off.
    expect(after.length).toBeGreaterThan(beforeRetry.length);
    for (let i = 1; i < after.length; i += 1) {
      expect(after[i]?.sequence).toBeGreaterThan(after[i - 1]?.sequence ?? -1);
    }
    expect(after.at(-1)?.sequence).toBeGreaterThan(lastSequenceBeforeRetry);
  });

  it("duplicate Retry step requests (sequential) create exactly one recovery", async () => {
    const harness = cancellableHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      maxAttemptsPerStep: 2,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await abandonRunningStep(harness, "run-1", "step-a", "task-a");
    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });

    await harness.scheduler.retryAbandonedStep("run-1", "step-a");
    // A second call after the first already succeeded — rejected, and for
    // TWO independently sufficient reasons (the step is no longer
    // "awaiting_intervention" with an "abandoned" latest attempt, AND the
    // attempt budget is now exhausted) — either is an acceptable, safe
    // rejection; this test only asserts that one occurs and that no
    // second attempt is ever created.
    await expect(harness.scheduler.retryAbandonedStep("run-1", "step-a")).rejects.toThrow(
      CeoPlanExecutionAbandonedRetryNotEligibleError,
    );
    expect(harness.planRunStore.listAttempts("run-1", "step-a")).toHaveLength(2);
  });

  it("concurrent Retry step requests create exactly one recovery — the loser gets a safe rejection, never a silent no-op or a second attempt", async () => {
    const harness = cancellableHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      maxAttemptsPerStep: 2,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await abandonRunningStep(harness, "run-1", "step-a", "task-a");
    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });

    const results = await Promise.allSettled([
      harness.scheduler.retryAbandonedStep("run-1", "step-a"),
      harness.scheduler.retryAbandonedStep("run-1", "step-a"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toBeInstanceOf(CeoPlanExecutionAbandonedRetryNotEligibleError);
    }
    expect(harness.planRunStore.listAttempts("run-1", "step-a")).toHaveLength(2);
  });

  it("assignment drift (no adapter/agent on the task) is rejected before any commit", async () => {
    const harness = cancellableHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      maxAttemptsPerStep: 2,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await abandonRunningStep(harness, "run-1", "step-a", "task-a");
    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });

    // Simulate assignment drift — never happens through a real route, but
    // proves the guard, not just the happy path.
    harness.taskStore.clearAssignment("task-a");

    await expect(harness.scheduler.retryAbandonedStep("run-1", "step-a")).rejects.toThrow(
      CeoPlanExecutionAbandonedRetryNotEligibleError,
    );
    expect(harness.planRunStore.listAttempts("run-1", "step-a")).toHaveLength(1);
  });

  it("an ordinary failed attempt (not abandoned) cannot use the abandoned-recovery path", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: false,
      }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      pauseOnAnyPermanentFailure: false,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");

    const [attempt] = harness.planRunStore.listAttempts("run-1", "step-a");
    expect(attempt?.status).toBe("failed");
    // The run itself never paused (an ordinary permanent failure with
    // `pauseOnAnyPermanentFailure: false` leaves the run "running") —
    // already the state the abandoned-recovery path requires; no resume
    // needed, and none is possible (the run isn't paused/awaiting
    // intervention to resume from).
    expect(harness.planRunStore.getRun("run-1").status).toBe("running");

    await expect(harness.scheduler.retryAbandonedStep("run-1", "step-a")).rejects.toThrow(
      CeoPlanExecutionAbandonedRetryNotEligibleError,
    );
  });

  it("a cancelled attempt cannot use the abandoned-recovery path", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    const [attempt] = harness.planRunStore.listAttempts("run-1", "step-a");
    if (!attempt) throw new Error("expected an attempt");
    harness.planRunStore.updateAttempt({ attemptId: attempt.id, status: "cancelled", now: NOW });
    harness.planRunStore.upsertStepExecution({
      runId: "run-1",
      planStepId: "step-a",
      status: "awaiting_intervention",
      readinessReason: "operator_intervention",
      dependencySummary: harness.planRunStore.getStepExecution("run-1", "step-a").dependencySummary,
    });

    await expect(harness.scheduler.retryAbandonedStep("run-1", "step-a")).rejects.toThrow(
      CeoPlanExecutionAbandonedRetryNotEligibleError,
    );
  });

  it("a completed attempt cannot use the abandoned-recovery path", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "completed");
    await harness.scheduler.onChildTaskMutated("task-a");

    const [attempt] = harness.planRunStore.listAttempts("run-1", "step-a");
    expect(attempt?.status).toBe("completed");
    // Force the step back to "awaiting_intervention" purely to isolate
    // this precondition from the (already-true) "step not completed" one.
    harness.planRunStore.upsertStepExecution({
      runId: "run-1",
      planStepId: "step-a",
      status: "awaiting_intervention",
      readinessReason: "operator_intervention",
      dependencySummary: harness.planRunStore.getStepExecution("run-1", "step-a").dependencySummary,
    });

    await expect(harness.scheduler.retryAbandonedStep("run-1", "step-a")).rejects.toThrow(
      CeoPlanExecutionAbandonedRetryNotEligibleError,
    );
  });

  it("a task failure code other than HALL_RESTART_INTERRUPTED_RUN cannot use the abandoned-recovery path, even if the attempt is marked abandoned", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: false,
      }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      pauseOnAnyPermanentFailure: false,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");

    const [attempt] = harness.planRunStore.listAttempts("run-1", "step-a");
    if (!attempt) throw new Error("expected an attempt");
    // An ordinary (non-restart) failure, artificially marked "abandoned" —
    // proves the failure-CODE check is independent of, and not redundant
    // with, the attempt-status check above it.
    harness.planRunStore.updateAttempt({ attemptId: attempt.id, status: "abandoned", now: NOW });
    harness.planRunStore.upsertStepExecution({
      runId: "run-1",
      planStepId: "step-a",
      status: "awaiting_intervention",
      readinessReason: "operator_intervention",
      dependencySummary: harness.planRunStore.getStepExecution("run-1", "step-a").dependencySummary,
    });
    harness.planRunStore.recoveryPauseRun({
      runId: "run-1",
      now: NOW,
      classification: "unclean_paused",
    });
    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });

    expect(harness.taskStore.get("task-a").failure?.code).not.toBe(RESTART_INTERRUPTED_RUN_CODE);
    await expect(harness.scheduler.retryAbandonedStep("run-1", "step-a")).rejects.toThrow(
      CeoPlanExecutionAbandonedRetryNotEligibleError,
    );
  });

  it("cross-plan / cross-run linkage is rejected — a stepId that only exists on a different run", async () => {
    const harness = cancellableHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    addAssignedTask(harness.taskStore, { taskId: "task-b" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    configureAndStart(harness, "run-2", "plan-2", [{ stepId: "step-b", childTaskId: "task-b" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await harness.scheduler.enqueueSignal({ planRunId: "run-2", reason: "execution_started" });
    await abandonRunningStep(harness, "run-1", "step-a", "task-a");
    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });

    // "step-b" belongs to run-2, never run-1.
    await expect(harness.scheduler.retryAbandonedStep("run-1", "step-b")).rejects.toThrow();
  });

  it("cross-step linkage is rejected — an unknown stepId on a real run", async () => {
    const harness = cancellableHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await abandonRunningStep(harness, "run-1", "step-a", "task-a");
    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });

    await expect(
      harness.scheduler.retryAbandonedStep("run-1", "step-does-not-exist"),
    ).rejects.toThrow();
  });

  it("no raw error, path, PID, owner token, epoch, or other internal detail leaks through the rejection message", async () => {
    const harness = cancellableHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await abandonRunningStep(harness, "run-1", "step-a", "task-a");
    // Deliberately not resumed — triggers the "run is not running" reason.

    try {
      await harness.scheduler.retryAbandonedStep("run-1", "step-a");
      expect.unreachable("expected retryAbandonedStep to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CeoPlanExecutionAbandonedRetryNotEligibleError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(WORKSPACE_ROOT);
      expect(message).not.toMatch(/owner[-_]?token/i);
      expect(message).not.toMatch(/epoch/i);
      expect(message).not.toMatch(/[/\\][A-Za-z]:[/\\]/);
      expect(message.length).toBeLessThan(300);
    }
  });

  it("the recovery event is emitted exactly once, attributed to the operator, and the Board audit is posted at most once", async () => {
    const boardAuditLog: string[] = [];
    const harness = cancellableHarness(boardAuditLog);
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      maxAttemptsPerStep: 2,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await abandonRunningStep(harness, "run-1", "step-a", "task-a");
    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });

    await harness.scheduler.retryAbandonedStep("run-1", "step-a");

    const events = harness.planRunStore.listEvents("run-1");
    const retryRequested = events.filter((e) => e.type === "ceo.execution.retry_requested");
    expect(retryRequested).toHaveLength(1);
    expect(retryRequested[0]?.actor).toBe("human:local-operator");
    expect(boardAuditLog).toHaveLength(1);
  });
});
