import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
import { DEFAULT_CEO_PLAN_EXECUTION_POLICY } from "@hall-of-wisdom/protocol";
import { TaskStore } from "../tasks/task-store.js";
import { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import { InMemoryCeoPlanStore } from "../ceo-plans/in-memory-ceo-plan-store.js";
import { computeCeoPlanContentHash } from "../ceo-plans/ceo-plan-content-hash.js";
import { createEphemeralAtomicUnit } from "../ceo-plans/ephemeral-atomic-unit.js";
import { InMemoryCeoPlanRunStore } from "./in-memory-ceo-plan-run-store.js";
import { InMemoryExecutionSignalStore } from "./in-memory-execution-signal-store.js";
import { CeoPlanExecutionScheduler } from "./ceo-plan-execution-scheduler.js";
import { runCeoPlanExecutionRecovery } from "./ceo-plan-execution-recovery.js";

const WORKSPACE_ROOT = process.cwd();
const NOW = "2026-07-31T12:00:00.000Z";

function buildHarness() {
  const registry = new AgentRegistry();
  registry.register(new MockAgentAdapter({ scenario: "success", stepDelayMs: 0 }));
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
  const planStore = new InMemoryCeoPlanStore();
  const planRunStore = new InMemoryCeoPlanRunStore();
  const signalStore = new InMemoryExecutionSignalStore();
  const boardAuditLog: string[] = [];
  const runAtomicUnit = createEphemeralAtomicUnit({ planRunStore, signalStore });
  const scheduler = new CeoPlanExecutionScheduler({
    planRunStore,
    signalStore,
    taskStore,
    taskOrchestrator,
    now: () => NOW,
    ownerToken: "owner-1",
    postBoardAudit: (_planId, text) => boardAuditLog.push(text),
    runAtomicUnit,
  });
  return {
    taskStore,
    taskOrchestrator,
    planStore,
    planRunStore,
    signalStore,
    scheduler,
    boardAuditLog,
    runAtomicUnit,
  };
}

function addAssignedTask(taskStore: TaskStore, taskId: string): void {
  taskStore.add({
    task: {
      taskId,
      projectId: "project-1",
      title: `Task ${taskId}`,
      description: "A step delegated by a CEO plan.",
      priority: "normal",
      status: "assigned",
      dependencyTaskIds: [],
      createdAt: NOW,
      updatedAt: NOW,
      requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
    },
    runId: undefined,
    adapterId: "hall.mock-agent",
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

/** Creates a real plan version (via `InMemoryCeoPlanStore`) with one step, and a matching plan run configured (but not started) against it — the harness for every test below. */
function createPlanAndRun(
  harness: ReturnType<typeof buildHarness>,
  input: {
    planId: string;
    runId: string;
    taskId: string;
    stepId: string;
    policy?: typeof DEFAULT_CEO_PLAN_EXECUTION_POLICY;
  },
) {
  const content = {
    objective: "Recovery test objective.",
    summary: "Recovery test summary.",
    assumptions: [],
    constraints: [],
    steps: [
      {
        id: input.stepId,
        position: 0,
        title: "Step one",
        objective: "Do the one thing.",
        boundedInstructions: "Do it.",
        acceptanceCriteria: ["It is done."],
        dependencies: [],
        routingSummary: "Routes to the mock agent.",
      },
    ],
  };
  harness.planStore.createPlan({
    planId: input.planId,
    parentTaskId: "parent-task-1",
    createdBy: "ceo_planner",
    createdAt: NOW,
    content,
    contentHash: computeCeoPlanContentHash(content),
  });
  harness.planRunStore.configureRun({
    runId: input.runId,
    planId: input.planId,
    planVersion: 1,
    executionMode: "autonomous",
    policy: input.policy ?? DEFAULT_CEO_PLAN_EXECUTION_POLICY,
    now: NOW,
    steps: [{ stepId: input.stepId, childTaskId: input.taskId, dependencyStepIds: [] }],
  });
}

describe("runCeoPlanExecutionRecovery", () => {
  it("unclean restart: pauses every running run, abandons non-terminal attempts, cancels pending signals, and posts exactly one bounded Board summary", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, "task-1");
    createPlanAndRun(harness, {
      planId: "plan-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
    });
    harness.planRunStore.startRun({ runId: "run-1", now: NOW });
    // Simulate an attempt that was mid-flight ("claimed") when the crash
    // happened — never actually reaches TaskOrchestrator here.
    harness.planRunStore.createAttempt({
      attemptId: "attempt-1",
      runId: "run-1",
      planStepId: "step-1",
      childTaskId: "task-1",
      attemptNumber: 1,
      triggerReason: "execution_started",
      schedulerSignalId: "signal-1",
      leaseGeneration: 0,
      ownerToken: "owner-1",
      now: NOW,
    });

    const summary = await runCeoPlanExecutionRecovery({
      planRunStore: harness.planRunStore,
      signalStore: harness.signalStore,
      taskStore: harness.taskStore,
      scheduler: harness.scheduler,
      planStore: harness.planStore,
      postBoardAudit: (_planId, text) => harness.boardAuditLog.push(text),
      previousShutdown: "unclean",
      now: NOW,
      runAtomicUnit: harness.runAtomicUnit,
    });

    expect(summary.runsScanned).toBe(1);
    expect(summary.runsPausedForUncleanRestart).toBe(1);
    expect(summary.attemptsAbandoned).toBe(1);
    expect(harness.planRunStore.getRun("run-1").status).toBe("awaiting_intervention");
    expect(harness.planRunStore.getRun("run-1").recoveryClassification).toBe("unclean_paused");
    expect(harness.planRunStore.getAttempt("attempt-1").status).toBe("abandoned");
    expect(harness.boardAuditLog).toHaveLength(1);

    // Never auto-started anything — no attempt beyond the one seeded above.
    expect(harness.planRunStore.listAttempts("run-1")).toHaveLength(1);
  });

  it("REGRESSION: unclean restart moves a step left 'running' to awaiting_intervention, not just abandoning its attempt — otherwise it is permanently excluded from ever being reconsidered again, even after an explicit resume", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, "task-1");
    createPlanAndRun(harness, {
      planId: "plan-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
      // maxAttemptsPerStep: 2 (not the default 1) — this test's
      // abandoned first attempt must leave room for a real second one,
      // otherwise "policy_limit_reached" (a separate, correct gate)
      // would mask whether THIS fix actually made the step
      // re-evaluatable.
      policy: { ...DEFAULT_CEO_PLAN_EXECUTION_POLICY, maxAttemptsPerStep: 2 },
    });
    harness.planRunStore.startRun({ runId: "run-1", now: NOW });
    // Simulate the step genuinely mid-flight ("running") when the crash
    // happened — `claimAttempt` (not the bare `createAttempt` the
    // sibling test above uses) is what actually moves the step
    // execution's own status, matching what a real in-flight step looks
    // like right before an unclean shutdown.
    const { attempt } = harness.planRunStore.claimAttempt({
      attemptId: "attempt-1",
      runId: "run-1",
      planStepId: "step-1",
      childTaskId: "task-1",
      attemptNumber: 1,
      triggerReason: "execution_started",
      schedulerSignalId: "signal-1",
      leaseGeneration: 0,
      ownerToken: "owner-1",
      now: NOW,
      readinessReason: "ready",
      dependencySummary: {
        totalDependencies: 0,
        completedDependencies: 0,
        failedDependencies: 0,
        cancelledDependencies: 0,
      },
    });
    harness.planRunStore.updateAttempt({ attemptId: attempt.id, status: "running", now: NOW });
    harness.planRunStore.upsertStepExecution({
      runId: "run-1",
      planStepId: "step-1",
      status: "running",
      readinessReason: "ready",
      dependencySummary: {
        totalDependencies: 0,
        completedDependencies: 0,
        failedDependencies: 0,
        cancelledDependencies: 0,
      },
    });

    await runCeoPlanExecutionRecovery({
      planRunStore: harness.planRunStore,
      signalStore: harness.signalStore,
      taskStore: harness.taskStore,
      scheduler: harness.scheduler,
      planStore: harness.planStore,
      postBoardAudit: (_planId, text) => harness.boardAuditLog.push(text),
      previousShutdown: "unclean",
      now: NOW,
      runAtomicUnit: harness.runAtomicUnit,
    });

    const stepAfterRecovery = harness.planRunStore.getStepExecution("run-1", "step-1");
    expect(stepAfterRecovery.status).toBe("awaiting_intervention");
    expect(harness.planRunStore.getAttempt(attempt.id).status).toBe("abandoned");

    // Prove it is genuinely re-evaluatable, not just relabeled: resume,
    // then send a plan-level signal, and confirm the step actually
    // reaches an active status again rather than staying permanently
    // excluded by `#tryAdvanceStep`'s own terminal-status guard.
    //
    // NOTE — residual gap, not fixed here: only the CLEAN-restart path
    // (and `/configure`) ever calls `registerDependencyIndex`. A run
    // resumed after an UNCLEAN-restart pause has no dependency index in
    // a freshly-restarted scheduler process unless something rebuilds
    // it, so this test rebuilds it explicitly to isolate what this fix
    // actually changed (the step's own status) from that separate,
    // undocumented-until-now gap in the resume path itself.
    harness.scheduler.registerDependencyIndex("run-1", [{ id: "step-1", dependencies: [] }]);
    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "operator_resumed" });
    const stepAfterResume = harness.planRunStore.getStepExecution("run-1", "step-1");
    expect(["claimed", "starting", "running"]).toContain(stepAfterResume.status);
  });

  it("unclean restart never posts a second Board summary or re-pauses an already-paused run on a repeated call", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, "task-1");
    createPlanAndRun(harness, {
      planId: "plan-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
    });
    harness.planRunStore.startRun({ runId: "run-1", now: NOW });

    const recoveryInput = {
      planRunStore: harness.planRunStore,
      signalStore: harness.signalStore,
      taskStore: harness.taskStore,
      scheduler: harness.scheduler,
      planStore: harness.planStore,
      postBoardAudit: (_planId: string, text: string) => harness.boardAuditLog.push(text),
      previousShutdown: "unclean" as const,
      now: NOW,
      runAtomicUnit: harness.runAtomicUnit,
    };

    const first = await runCeoPlanExecutionRecovery(recoveryInput);
    const second = await runCeoPlanExecutionRecovery(recoveryInput);

    expect(first.runsPausedForUncleanRestart).toBe(1);
    expect(second.runsPausedForUncleanRestart).toBe(0);
    expect(second.runsScanned).toBe(0);
    expect(harness.boardAuditLog).toHaveLength(1);
  });

  it("clean restart: rebuilds the dependency index and enqueues startup_reconciliation, letting the eligible step actually start", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, "task-1");
    createPlanAndRun(harness, {
      planId: "plan-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
    });
    harness.planRunStore.startRun({ runId: "run-1", now: NOW });

    const summary = await runCeoPlanExecutionRecovery({
      planRunStore: harness.planRunStore,
      signalStore: harness.signalStore,
      taskStore: harness.taskStore,
      scheduler: harness.scheduler,
      planStore: harness.planStore,
      postBoardAudit: (_planId, text) => harness.boardAuditLog.push(text),
      previousShutdown: "clean",
      now: NOW,
      runAtomicUnit: harness.runAtomicUnit,
    });

    expect(summary.runsContinuedAfterCleanRestart).toBe(1);
    expect(summary.runsPausedForUncleanRestart).toBe(0);
    expect(harness.planRunStore.getRun("run-1").status).toBe("running");
    expect(harness.planRunStore.listAttempts("run-1")).toHaveLength(1);
  });

  it("clean restart skips a run whose exact approved plan version can no longer be resolved, without throwing", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, "task-1");
    // Configure a run against a plan version that is never actually
    // created in `planStore` — simulates data loss/corruption the
    // recovery pass must fail closed on, not crash on.
    harness.planRunStore.configureRun({
      runId: "run-1",
      planId: "missing-plan",
      planVersion: 1,
      executionMode: "autonomous",
      policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      now: NOW,
      steps: [{ stepId: "step-1", childTaskId: "task-1", dependencyStepIds: [] }],
    });
    harness.planRunStore.startRun({ runId: "run-1", now: NOW });

    const summary = await runCeoPlanExecutionRecovery({
      planRunStore: harness.planRunStore,
      signalStore: harness.signalStore,
      taskStore: harness.taskStore,
      scheduler: harness.scheduler,
      planStore: harness.planStore,
      postBoardAudit: (_planId, text) => harness.boardAuditLog.push(text),
      previousShutdown: "clean",
      now: NOW,
      runAtomicUnit: harness.runAtomicUnit,
    });

    expect(summary.runsSkippedMissingPlan).toBe(1);
    expect(summary.runsContinuedAfterCleanRestart).toBe(0);
    expect(harness.planRunStore.getRun("run-1").status).toBe("running");
  });

  it("leaves a run that is not 'running' (e.g. already paused) untouched by either recovery path", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, "task-1");
    createPlanAndRun(harness, {
      planId: "plan-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
    });
    harness.planRunStore.startRun({ runId: "run-1", now: NOW });
    harness.planRunStore.pauseRun({ runId: "run-1", now: NOW });

    const summary = await runCeoPlanExecutionRecovery({
      planRunStore: harness.planRunStore,
      signalStore: harness.signalStore,
      taskStore: harness.taskStore,
      scheduler: harness.scheduler,
      planStore: harness.planStore,
      postBoardAudit: (_planId, text) => harness.boardAuditLog.push(text),
      previousShutdown: "unclean",
      now: NOW,
      runAtomicUnit: harness.runAtomicUnit,
    });

    expect(summary.runsScanned).toBe(0);
    expect(harness.planRunStore.getRun("run-1").status).toBe("paused");
    expect(harness.boardAuditLog).toHaveLength(0);
  });

  it("continues an unlaunched replacement attempt only when a durable abandoned-retry intent exists", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, "task-1");
    createPlanAndRun(harness, {
      planId: "plan-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
      policy: { ...DEFAULT_CEO_PLAN_EXECUTION_POLICY, maxAttemptsPerStep: 2 },
    });
    harness.planRunStore.startRun({ runId: "run-1", now: NOW });
    harness.planRunStore.createAttempt({
      attemptId: "attempt-1",
      runId: "run-1",
      planStepId: "step-1",
      childTaskId: "task-1",
      attemptNumber: 1,
      triggerReason: "execution_started",
      schedulerSignalId: "signal-1",
      leaseGeneration: 0,
      ownerToken: "owner-1",
      now: NOW,
    });
    harness.planRunStore.updateAttempt({ attemptId: "attempt-1", status: "abandoned", now: NOW });
    const { intent } = harness.planRunStore.claimAbandonedRetryIntent({
      intentId: "intent-1",
      runId: "run-1",
      planStepId: "step-1",
      childTaskId: "task-1",
      abandonedAttemptId: "attempt-1",
      now: NOW,
    });
    const { attempt: replacement } = harness.planRunStore.claimAttempt({
      attemptId: "attempt-2",
      runId: "run-1",
      planStepId: "step-1",
      childTaskId: "task-1",
      attemptNumber: 2,
      triggerReason: "operator_manual_retry",
      schedulerSignalId: "signal-2",
      leaseGeneration: 1,
      ownerToken: "owner-1",
      now: NOW,
      readinessReason: "ready",
      dependencySummary: {
        totalDependencies: 0,
        completedDependencies: 0,
        failedDependencies: 0,
        cancelledDependencies: 0,
      },
    });
    harness.planRunStore.linkAbandonedRetryIntentReplacement({
      intentId: intent.id,
      replacementAttemptId: replacement.id,
      now: NOW,
    });

    const summary = await runCeoPlanExecutionRecovery({
      planRunStore: harness.planRunStore,
      signalStore: harness.signalStore,
      taskStore: harness.taskStore,
      scheduler: harness.scheduler,
      planStore: harness.planStore,
      postBoardAudit: (_planId, text) => harness.boardAuditLog.push(text),
      previousShutdown: "unclean",
      now: NOW,
      runAtomicUnit: harness.runAtomicUnit,
    });

    expect(summary.abandonedRetryIntentsContinued).toBe(1);
    expect(summary.attemptsAbandoned).toBe(0);
    const attempts = harness.planRunStore.listAttempts("run-1", "step-1");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.status).toBe("abandoned");
    expect(attempts[1]?.id).toBe("attempt-2");
    expect(attempts[1]?.taskRunId).toBeDefined();
    expect(harness.taskStore.get("task-1").runId).toBeDefined();
  });

  it("fails closed for legacy ambiguous partial retry state with no durable operator intent", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, "task-1");
    createPlanAndRun(harness, {
      planId: "plan-1",
      runId: "run-1",
      taskId: "task-1",
      stepId: "step-1",
      policy: { ...DEFAULT_CEO_PLAN_EXECUTION_POLICY, maxAttemptsPerStep: 2 },
    });
    harness.planRunStore.startRun({ runId: "run-1", now: NOW });
    harness.planRunStore.createAttempt({
      attemptId: "attempt-1",
      runId: "run-1",
      planStepId: "step-1",
      childTaskId: "task-1",
      attemptNumber: 1,
      triggerReason: "execution_started",
      schedulerSignalId: "signal-1",
      leaseGeneration: 0,
      ownerToken: "owner-1",
      now: NOW,
    });
    harness.planRunStore.updateAttempt({ attemptId: "attempt-1", status: "abandoned", now: NOW });
    harness.planRunStore.upsertStepExecution({
      runId: "run-1",
      planStepId: "step-1",
      status: "awaiting_intervention",
      readinessReason: "operator_intervention",
      dependencySummary: {
        totalDependencies: 0,
        completedDependencies: 0,
        failedDependencies: 0,
        cancelledDependencies: 0,
      },
    });

    const summary = await runCeoPlanExecutionRecovery({
      planRunStore: harness.planRunStore,
      signalStore: harness.signalStore,
      taskStore: harness.taskStore,
      scheduler: harness.scheduler,
      planStore: harness.planStore,
      postBoardAudit: (_planId, text) => harness.boardAuditLog.push(text),
      previousShutdown: "unclean",
      now: NOW,
      runAtomicUnit: harness.runAtomicUnit,
    });

    expect(summary.abandonedRetryIntentsContinued).toBe(0);
    expect(harness.planRunStore.listAbandonedRetryIntents()).toHaveLength(0);
    expect(harness.planRunStore.listAttempts("run-1", "step-1")).toHaveLength(1);
    expect(harness.signalStore.countByState().pending).toBe(0);
    expect(harness.taskStore.get("task-1").task.status).toBe("assigned");
  });
});
