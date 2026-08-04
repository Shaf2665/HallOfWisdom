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
import { InMemoryCeoPlanRunStore } from "./in-memory-ceo-plan-run-store.js";
import { InMemoryExecutionSignalStore } from "./in-memory-execution-signal-store.js";
import { CeoPlanExecutionScheduler } from "./ceo-plan-execution-scheduler.js";

const WORKSPACE_ROOT = process.cwd();
const NOW = "2026-07-31T12:00:00.000Z";

/**
 * Real `TaskStore`/`TaskOrchestrator`/`AgentRegistry`, exactly like
 * `task-orchestrator.test.ts`'s harness — the scheduler under test never
 * gets a mocked `TaskOrchestrator`, since the entire point of these tests
 * is proving it drives the real start path. Only `MockAgentAdapter`
 * (deterministic, in-process, zero real provider usage) is registered.
 */
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

async function completeTaskAndReconcile(
  harness: ReturnType<typeof buildHarness>,
  taskId: string,
): Promise<void> {
  await waitUntil(() => harness.taskStore.get(taskId).task.status === "completed");
  await harness.scheduler.onChildTaskMutated(taskId);
}

describe("CeoPlanExecutionScheduler", () => {
  it("manual mode starts nothing, even once the run is 'running'", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    harness.planRunStore.configureRun({
      runId: "run-1",
      planId: "plan-1",
      planVersion: 1,
      executionMode: "manual",
      policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      now: NOW,
      steps: [{ stepId: "step-a", childTaskId: "task-a", dependencyStepIds: [] }],
    });
    harness.scheduler.registerDependencyIndex("run-1", [{ id: "step-a", dependencies: [] }]);
    harness.planRunStore.startRun({ runId: "run-1", now: NOW });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    expect(harness.taskStore.get("task-a").task.status).toBe("assigned");
    expect(harness.taskStore.get("task-a").runId).toBeUndefined();
  });

  it("autonomous mode starts nothing before the run is explicitly started (still 'configured')", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    harness.planRunStore.configureRun({
      runId: "run-1",
      planId: "plan-1",
      planVersion: 1,
      executionMode: "autonomous",
      policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      now: NOW,
      steps: [{ stepId: "step-a", childTaskId: "task-a", dependencyStepIds: [] }],
    });
    harness.scheduler.registerDependencyIndex("run-1", [{ id: "step-a", dependencies: [] }]);
    // Deliberately never called: harness.planRunStore.startRun(...)
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    expect(harness.taskStore.get("task-a").runId).toBeUndefined();
  });

  it("onChildTaskMutated does nothing to a step-execution whose run is still 'configured' (never started) — a child task finished by some other means ahead of the run must not be treated as already resolved", async () => {
    // Guards the allow-list in `onChildTaskMutated` against being loosened
    // into a blanket "not terminal" check: `"configured"` must stay
    // excluded, or a child task started manually from the Kanban board
    // before `Start execution…` would get its step-execution row marked
    // "completed" here, and `#tryAdvanceStep` would then treat that step
    // as already resolved the moment the run actually starts — satisfied
    // without ever claiming a real attempt.
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    harness.planRunStore.configureRun({
      runId: "run-1",
      planId: "plan-1",
      planVersion: 1,
      executionMode: "autonomous",
      policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      now: NOW,
      steps: [{ stepId: "step-a", childTaskId: "task-a", dependencyStepIds: [] }],
    });
    harness.scheduler.registerDependencyIndex("run-1", [{ id: "step-a", dependencies: [] }]);
    expect(harness.planRunStore.getRun("run-1").status).toBe("configured");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("ready");

    harness.taskStore.updateStatus("task-a", "running");
    harness.taskStore.updateStatus("task-a", "completed");
    harness.taskStore.setCompleted("task-a", NOW, "run.completed");
    await harness.scheduler.onChildTaskMutated("task-a");

    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("ready");
  });

  it("a single dependency-free step starts on the initial execution_started signal", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    expect(harness.taskStore.get("task-a").runId).toBeDefined();
    const stepExec = harness.planRunStore.getStepExecution("run-1", "step-a");
    expect(["claimed", "starting", "running"]).toContain(stepExec.status);
  });

  it("two independent ready steps both start when maxConcurrentSteps is 2", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    addAssignedTask(harness.taskStore, { taskId: "task-b" });
    configureAndStart(
      harness,
      "run-1",
      "plan-1",
      [
        { stepId: "step-a", childTaskId: "task-a" },
        { stepId: "step-b", childTaskId: "task-b" },
      ],
      // Plan-level concurrency (2) is independent from adapter capacity
      // (default 1 — see the dedicated adapter-capacity test below);
      // widen the override here so this test isolates maxConcurrentSteps.
      { maxConcurrentSteps: 2, adapterConcurrencyOverrides: { "hall.mock-agent": 2 } },
    );
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    expect(harness.taskStore.get("task-a").runId).toBeDefined();
    expect(harness.taskStore.get("task-b").runId).toBeDefined();
  });

  it("defaults to one active run per adapter when no capacity override is configured, even under a higher plan concurrency", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({ scenario: "cancellable", stepDelayMs: 5000 }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    addAssignedTask(harness.taskStore, { taskId: "task-b" });
    configureAndStart(
      harness,
      "run-1",
      "plan-1",
      [
        { stepId: "step-a", childTaskId: "task-a" },
        { stepId: "step-b", childTaskId: "task-b" },
      ],
      { maxConcurrentSteps: 2 },
    );
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    const startedA = harness.taskStore.get("task-a").runId !== undefined;
    const startedB = harness.taskStore.get("task-b").runId !== undefined;
    expect(startedA !== startedB).toBe(true);
  });

  it("a third ready step waits when concurrency is already full", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({ scenario: "cancellable", stepDelayMs: 5000 }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    addAssignedTask(harness.taskStore, { taskId: "task-b" });
    configureAndStart(
      harness,
      "run-1",
      "plan-1",
      [
        { stepId: "step-a", childTaskId: "task-a" },
        { stepId: "step-b", childTaskId: "task-b" },
      ],
      { maxConcurrentSteps: 1 },
    );
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    const startedA = harness.taskStore.get("task-a").runId !== undefined;
    const startedB = harness.taskStore.get("task-b").runId !== undefined;
    // Exactly one of the two started — never both, never neither.
    expect(startedA !== startedB).toBe(true);
    const waitingStep = startedA ? "step-b" : "step-a";
    expect(harness.planRunStore.getStepExecution("run-1", waitingStep).readinessReason).toBe(
      "waiting_for_capacity",
    );
  });

  it("a step in one run blocked on shared adapter capacity is woken (not starved) once a DIFFERENT run's task on that adapter frees a slot — no starvation (kickoff §10E)", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    addAssignedTask(harness.taskStore, { taskId: "task-b" });
    // Two entirely separate runs sharing the same adapter's default
    // capacity of 1 — deliberately no `adapterConcurrencyOverrides`.
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    configureAndStart(harness, "run-2", "plan-2", [{ stepId: "step-b", childTaskId: "task-b" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await harness.scheduler.enqueueSignal({ planRunId: "run-2", reason: "execution_started" });
    expect(harness.taskStore.get("task-a").runId).toBeDefined();
    expect(harness.taskStore.get("task-b").runId).toBeUndefined();
    expect(harness.planRunStore.getStepExecution("run-2", "step-b").readinessReason).toBe(
      "waiting_for_capacity",
    );

    // Reconciling run-1's own task completion must wake run-2's parked
    // step too — nothing is ever separately signalled for run-2 here.
    await completeTaskAndReconcile(harness, "task-a");

    await waitUntil(() => harness.taskStore.get("task-b").runId !== undefined);
    expect(harness.planRunStore.getStepExecution("run-2", "step-b").readinessReason).not.toBe(
      "waiting_for_capacity",
    );
  });

  it("a dependent step starts only after every dependency has completed", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    addAssignedTask(harness.taskStore, { taskId: "task-b", dependencyTaskIds: ["task-a"] });
    configureAndStart(harness, "run-1", "plan-1", [
      { stepId: "step-a", childTaskId: "task-a" },
      { stepId: "step-b", childTaskId: "task-b", dependencyStepIds: ["step-a"] },
    ]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    expect(harness.taskStore.get("task-b").runId).toBeUndefined();
    expect(harness.planRunStore.getStepExecution("run-1", "step-b").status).toBe(
      "waiting_for_dependencies",
    );

    await completeTaskAndReconcile(harness, "task-a");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("completed");
    expect(harness.taskStore.get("task-b").runId).toBeDefined();
  });

  it("a failed dependency blocks its dependent and pauses the run for intervention (pauseOnAnyPermanentFailure)", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({ scenario: "failure", stepDelayMs: 0 }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    addAssignedTask(harness.taskStore, { taskId: "task-b", dependencyTaskIds: ["task-a"] });
    configureAndStart(
      harness,
      "run-1",
      "plan-1",
      [
        { stepId: "step-a", childTaskId: "task-a" },
        { stepId: "step-b", childTaskId: "task-b", dependencyStepIds: ["step-a"] },
      ],
      { pauseOnAnyPermanentFailure: true },
    );
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");

    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("failed");
    expect(harness.planRunStore.getRun("run-1").status).toBe("awaiting_intervention");
    expect(harness.taskStore.get("task-b").runId).toBeUndefined();
  });

  it("adapter unavailable at launch time blocks the attempt without ever calling the adapter's real work", async () => {
    const unavailableAdapter: AgentAdapter = {
      descriptor: new MockAgentAdapter().descriptor,
      detect: () => Promise.resolve({ installed: true, availability: "busy" }),
      startTask: () => {
        throw new Error("must never be called — detect() already reported unavailable");
      },
    };
    const harness = buildHarness({ adapter: unavailableAdapter });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    expect(harness.taskStore.get("task-a").runId).toBeUndefined();
    const stepExec = harness.planRunStore.getStepExecution("run-1", "step-a");
    expect(stepExec.status).toBe("awaiting_intervention");
    const attempts = harness.planRunStore.listAttempts("run-1", "step-a");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("failed");
  });

  it("duplicate signals for the same step coalesce into exactly one attempt", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({ scenario: "cancellable", stepDelayMs: 5000 }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    // 10 equivalent, rapid-fire signals for the same step, before any of
    // them have been drained — this is the coalescing scenario, not a
    // sequence of 10 independent triggers.
    for (let i = 0; i < 10; i += 1) {
      harness.signalStore.enqueue({
        signalId: `dup-${String(i)}`,
        planRunId: "run-1",
        planStepId: "step-a",
        generation: 0,
        reason: "execution_started",
        priority: "normal",
        availableAt: NOW,
        now: NOW,
      });
    }
    expect(harness.signalStore.listSignalsForRun("run-1")).toHaveLength(1);
    await harness.scheduler.tick();
    expect(harness.planRunStore.listAttempts("run-1", "step-a")).toHaveLength(1);
  });

  it("two concurrent scheduler workers racing the same claimable signal produce exactly one launch intent", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({ scenario: "cancellable", stepDelayMs: 5000 }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    harness.signalStore.enqueue({
      signalId: "sig-race",
      planRunId: "run-1",
      planStepId: "step-a",
      generation: 0,
      reason: "execution_started",
      priority: "normal",
      availableAt: NOW,
      now: NOW,
    });
    // Two independent scheduler instances sharing the exact same durable
    // stores — the real-world shape of two Hall Core scheduler ticks
    // racing the same signal queue. `signalStore.claimNext`'s own
    // atomicity must ensure only one of these two `tick()` calls ever
    // claims the one pending signal.
    const workerB = new CeoPlanExecutionScheduler({
      planRunStore: harness.planRunStore,
      signalStore: harness.signalStore,
      taskStore: harness.taskStore,
      taskOrchestrator: harness.taskOrchestrator,
      now: () => NOW,
      ownerToken: "owner-2",
      leaseSeconds: 30,
      postBoardAudit: () => undefined,
      runAtomicUnit: createEphemeralAtomicUnit({
        planRunStore: harness.planRunStore,
        signalStore: harness.signalStore,
      }),
    });
    workerB.registerDependencyIndex("run-1", [{ id: "step-a", dependencies: [] }]);
    const [a, b] = await Promise.all([harness.scheduler.tick(), workerB.tick()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(harness.planRunStore.listAttempts("run-1", "step-a")).toHaveLength(1);
  });

  it("a stale-generation signal (queued before a pause/resume) never starts anything", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    // A signal manually stamped with generation 0, injected AFTER the run
    // has already moved to generation 1 (simulating a signal that was
    // in-flight when an operator paused-then-resumed).
    harness.planRunStore.pauseRun({ runId: "run-1", now: NOW });
    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });
    expect(harness.planRunStore.getRun("run-1").activeGeneration).toBe(1);
    harness.signalStore.enqueue({
      signalId: "stale-sig",
      planRunId: "run-1",
      planStepId: "step-a",
      generation: 0,
      reason: "execution_started",
      priority: "normal",
      availableAt: NOW,
      now: NOW,
    });
    await harness.scheduler.tick();
    expect(harness.taskStore.get("task-a").runId).toBeUndefined();
  });

  it("pause prevents new starts; an already-running task is left untouched", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({ scenario: "cancellable", stepDelayMs: 5000 }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    addAssignedTask(harness.taskStore, { taskId: "task-b" });
    configureAndStart(
      harness,
      "run-1",
      "plan-1",
      [
        { stepId: "step-a", childTaskId: "task-a" },
        { stepId: "step-b", childTaskId: "task-b" },
      ],
      { maxConcurrentSteps: 1 },
    );
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    const runningTaskId = harness.taskStore.get("task-a").runId !== undefined ? "task-a" : "task-b";
    const waitingTaskId = runningTaskId === "task-a" ? "task-b" : "task-a";

    harness.planRunStore.pauseRun({ runId: "run-1", now: NOW });
    harness.signalStore.cancelSignalsForRun("run-1", NOW);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "capacity_available" });

    expect(harness.taskStore.get(runningTaskId).task.status).toBe("running");
    expect(harness.taskStore.get(waitingTaskId).runId).toBeUndefined();
  });

  it("resume revalidates and starts the previously-waiting step", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({ scenario: "cancellable", stepDelayMs: 5000 }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      maxConcurrentSteps: 1,
    });
    harness.planRunStore.pauseRun({ runId: "run-1", now: NOW });
    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "operator_resumed" });
    expect(harness.taskStore.get("task-a").runId).toBeDefined();
  });

  it("cancel prevents all future starts, including for steps that were already ready", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    harness.planRunStore.cancelRun({ runId: "run-1", now: NOW });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    expect(harness.taskStore.get("task-a").runId).toBeUndefined();
  });

  it("a completed step never receives a second attempt", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await completeTaskAndReconcile(harness, "task-a");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("completed");
    // A redundant re-trigger for the same already-completed step.
    await harness.scheduler.enqueueSignal({
      planRunId: "run-1",
      planStepId: "step-a",
      reason: "retry_due",
    });
    expect(harness.planRunStore.listAttempts("run-1", "step-a")).toHaveLength(1);
  });

  it("the run completes exactly once, with one completion event and one bounded Board summary, once every step is done", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await completeTaskAndReconcile(harness, "task-a");

    expect(harness.planRunStore.getRun("run-1").status).toBe("completed");
    const completionEvents = harness.planRunStore
      .listEvents("run-1")
      .filter((e) => e.type === "ceo.execution.completed");
    expect(completionEvents).toHaveLength(1);
    expect(harness.boardAuditLog.filter((m) => m.includes("completed"))).toHaveLength(1);

    // Re-driving the same mutation a second time (e.g. a duplicate
    // task-mutation-hook callback) must not complete the run again or
    // duplicate the event/Board summary.
    await harness.scheduler.onChildTaskMutated("task-a");
    expect(
      harness.planRunStore.listEvents("run-1").filter((e) => e.type === "ceo.execution.completed"),
    ).toHaveLength(1);
    expect(harness.boardAuditLog.filter((m) => m.includes("completed"))).toHaveLength(1);
  });

  it("an unrelated task's completion never touches this run's steps (no cross-run scan)", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    addAssignedTask(harness.taskStore, { taskId: "unrelated-task" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.onChildTaskMutated("unrelated-task");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("ready");
    expect(harness.taskStore.get("task-a").runId).toBeUndefined();
  });

  it("emergency stop requests cancellation for every linked active task, leaves an unrelated task's run alone, and prevents further scheduling", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({ scenario: "cancellable", stepDelayMs: 5000 }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    addAssignedTask(harness.taskStore, { taskId: "task-c" });
    addAssignedTask(harness.taskStore, { taskId: "unrelated-task" });
    configureAndStart(
      harness,
      "run-1",
      "plan-1",
      [
        { stepId: "step-a", childTaskId: "task-a" },
        { stepId: "step-c", childTaskId: "task-c" },
      ],
      { maxConcurrentSteps: 2, adapterConcurrencyOverrides: { "hall.mock-agent": 2 } },
    );
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });

    expect(harness.taskStore.get("task-a").task.status).toBe("running");
    expect(harness.taskStore.get("task-c").task.status).toBe("running");

    const result = harness.scheduler.emergencyStop("run-1");

    expect(result.allSucceeded).toBe(true);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o) => o.outcome === "cancellation_requested")).toBe(true);
    expect(harness.taskStore.get("task-a").cancellationRequested).toBe(true);
    expect(harness.taskStore.get("task-c").cancellationRequested).toBe(true);
    expect(harness.taskStore.get("unrelated-task").cancellationRequested).toBe(false);
    expect(harness.planRunStore.getRun("run-1").status).toBe("paused");
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "cancelled");
    const cancelledEvent = harness.eventStore
      .list("task-a")
      .find((event) => event.type === "run.cancelled");
    expect(cancelledEvent?.payload.cancelledBy).toBe("orchestrator");

    const emergencyEvents = harness.planRunStore
      .listEvents("run-1")
      .filter((e) => e.type === "ceo.execution.emergency_stop_requested");
    expect(emergencyEvents).toHaveLength(1);
    expect(harness.boardAuditLog.some((m) => m.includes("Emergency stop"))).toBe(true);
  });

  it("a step-execution reconciles to 'cancelled' once its emergency-stopped task actually finishes cancelling — never stays stuck on 'running' just because the run itself already moved off 'running'", async () => {
    // Reproduces a real, browser-observed defect: `emergencyStop()` pauses
    // the run SYNCHRONOUSLY, before the cancellation it requests actually
    // resolves. `onChildTaskMutated`'s old guard (`run.status !==
    // "running"`) then silently dropped the step-execution reconciliation
    // for the resulting terminal "cancelled" task status, since by the
    // time it arrived the run was already "paused" — leaving the
    // step-execution stuck reporting "running" forever, even though the
    // underlying task had genuinely finished cancelling.
    const harness = buildHarness({
      adapter: new MockAgentAdapter({ scenario: "cancellable", stepDelayMs: 5000 }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    expect(harness.taskStore.get("task-a").task.status).toBe("running");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("running");

    const result = harness.scheduler.emergencyStop("run-1");
    expect(result.allSucceeded).toBe(true);
    expect(harness.planRunStore.getRun("run-1").status).toBe("paused");
    // Still "running" immediately after emergency stop returns — the
    // underlying cancellation is requested but hasn't resolved yet.
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("running");

    await waitUntil(() => harness.taskStore.get("task-a").task.status === "cancelled");
    await harness.scheduler.onChildTaskMutated("task-a");

    const stepExec = harness.planRunStore.getStepExecution("run-1", "step-a");
    expect(stepExec.status).toBe("cancelled");
    expect(stepExec.completedAt).toBeDefined();
    // The run itself must stay exactly where the operator left it —
    // reconciling the step's own final status is never allowed to
    // resurrect scheduling on an already-paused run.
    expect(harness.planRunStore.getRun("run-1").status).toBe("paused");
  });

  it("emergency stop never reports overall success when one linked active task cannot be cancelled", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({ scenario: "cancellable", stepDelayMs: 5000 }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    expect(harness.taskStore.get("task-a").task.status).toBe("running");

    // A task that is already terminal by the time emergency stop reaches
    // it — `requestCancellation` throws for a terminal task — simulating
    // the exact race the kickoff's "never report success if one active
    // run couldn't be cancelled" guards against.
    harness.taskStore.setCancellationRequested("task-a");
    harness.taskStore.updateStatus("task-a", "completed");
    harness.taskStore.setCompleted("task-a", NOW, "run.completed");

    const result = harness.scheduler.emergencyStop("run-1");

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.outcome).toBe("failed");
    expect(result.allSucceeded).toBe(false);
    expect(harness.boardAuditLog.some((m) => m.includes("could not be cancelled"))).toBe(true);
  });

  it("never invokes a real Claude Code or Codex process — only the registered MockAgentAdapter's in-process startTask runs", async () => {
    let mockStartCalls = 0;
    const trackedAdapter = new MockAgentAdapter({ scenario: "success", stepDelayMs: 0 });
    const originalStartTask = trackedAdapter.startTask.bind(trackedAdapter);
    trackedAdapter.startTask = (input) => {
      mockStartCalls += 1;
      return originalStartTask(input);
    };
    const harness = buildHarness({ adapter: trackedAdapter });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    expect(mockStartCalls).toBe(1);
  });
});
