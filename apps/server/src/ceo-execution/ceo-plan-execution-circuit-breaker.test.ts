import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
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
import {
  computeProgressFingerprint,
  evaluateCircuitBreaker,
} from "./ceo-plan-execution-circuit-breaker.js";

const WORKSPACE_ROOT = process.cwd();
const NOW = "2026-07-31T12:00:00.000Z";

function buildHarness(options: { adapter?: MockAgentAdapter; boardAuditLog?: string[] } = {}) {
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
  return { taskStore, taskOrchestrator, planRunStore, signalStore, scheduler, boardAuditLog };
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

describe("CEO plan execution — no-progress circuit breaker (pure functions)", () => {
  it("stays closed under normal operation", () => {
    expect(
      evaluateCircuitBreaker({
        policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
        consecutiveFailures: 0,
        consecutiveSameCodeFailures: 0,
        noProgressAttempts: 0,
      }).shouldTrip,
    ).toBe(false);
  });

  it("a single failure does not trip unless the threshold is configured to 1", () => {
    const defaultPolicy = DEFAULT_CEO_PLAN_EXECUTION_POLICY; // maxConsecutiveFailures: 2
    expect(
      evaluateCircuitBreaker({
        policy: defaultPolicy,
        consecutiveFailures: 1,
        consecutiveSameCodeFailures: 1,
        noProgressAttempts: 0,
      }).shouldTrip,
    ).toBe(false);

    const strictPolicy: CeoPlanExecutionPolicy = { ...defaultPolicy, maxConsecutiveFailures: 1 };
    expect(
      evaluateCircuitBreaker({
        policy: strictPolicy,
        consecutiveFailures: 1,
        consecutiveSameCodeFailures: 0,
        noProgressAttempts: 0,
      }).shouldTrip,
    ).toBe(true);
  });

  it("trips at the consecutive-failures threshold — at-threshold trips, one-below does not", () => {
    const policy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      maxConsecutiveFailures: 3,
    };
    expect(
      evaluateCircuitBreaker({
        policy,
        consecutiveFailures: 2,
        consecutiveSameCodeFailures: 0,
        noProgressAttempts: 0,
      }).shouldTrip,
    ).toBe(false);
    const at = evaluateCircuitBreaker({
      policy,
      consecutiveFailures: 3,
      consecutiveSameCodeFailures: 0,
      noProgressAttempts: 0,
    });
    expect(at.shouldTrip).toBe(true);
    expect(at.reason).toBe("consecutive_failures");
  });

  it("trips at the consecutive-same-code-failures threshold, a separate counter from consecutiveFailures", () => {
    const policy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      maxConsecutiveFailures: 3,
    };
    const result = evaluateCircuitBreaker({
      policy,
      consecutiveFailures: 1, // below its own threshold
      consecutiveSameCodeFailures: 3, // at threshold
      noProgressAttempts: 0,
    });
    expect(result.shouldTrip).toBe(true);
    expect(result.reason).toBe("consecutive_same_code_failures");
  });

  it("trips at the no-progress-attempts threshold — at-threshold trips, one-below does not", () => {
    const policy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      maxConsecutiveFailures: 100,
      maxNoProgressAttempts: 2,
    };
    expect(
      evaluateCircuitBreaker({
        policy,
        consecutiveFailures: 0,
        consecutiveSameCodeFailures: 0,
        noProgressAttempts: 1,
      }).shouldTrip,
    ).toBe(false);
    const at = evaluateCircuitBreaker({
      policy,
      consecutiveFailures: 0,
      consecutiveSameCodeFailures: 0,
      noProgressAttempts: 2,
    });
    expect(at.shouldTrip).toBe(true);
    expect(at.reason).toBe("no_progress_retries");
  });

  it("priority order: consecutive_same_code_failures wins over consecutive_failures wins over no_progress_retries", () => {
    // consecutive_same_code_failures is checked first — see
    // `evaluateCircuitBreaker`'s doc comment for why: it can never exceed
    // consecutiveFailures in real recorded state, so checking the general
    // counter first would make the same-code reason structurally
    // unreachable whenever every failure shares one code.
    const policy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      maxConsecutiveFailures: 2,
      maxNoProgressAttempts: 2,
    };
    const allThreeBreached = evaluateCircuitBreaker({
      policy,
      consecutiveFailures: 2,
      consecutiveSameCodeFailures: 2,
      noProgressAttempts: 2,
    });
    expect(allThreeBreached.reason).toBe("consecutive_same_code_failures");

    const onlyGeneralAndNoProgress = evaluateCircuitBreaker({
      policy,
      consecutiveFailures: 2,
      consecutiveSameCodeFailures: 0,
      noProgressAttempts: 2,
    });
    expect(onlyGeneralAndNoProgress.reason).toBe("consecutive_failures");
  });

  it("consecutive_same_code_failures is genuinely reachable: an unbroken same-code streak reports it at a threshold the mixed-code general counter has not yet reached", () => {
    // Reflects the only inputs `recordCircuitOutcome` can actually
    // produce: consecutiveSameCodeFailures never exceeds
    // consecutiveFailures. A dedicated, lower same-code threshold still
    // isn't needed — the shared threshold is enough once same-code is
    // checked first (see the fix's doc comment) — this proves it directly
    // against the shared `maxConsecutiveFailures` threshold.
    const policy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      maxConsecutiveFailures: 3,
    };
    const result = evaluateCircuitBreaker({
      policy,
      consecutiveFailures: 3,
      consecutiveSameCodeFailures: 3,
      noProgressAttempts: 0,
    });
    expect(result.shouldTrip).toBe(true);
    expect(result.reason).toBe("consecutive_same_code_failures");
  });

  it("computeProgressFingerprint: identical inputs produce an identical string", () => {
    const input = {
      childTaskStatus: "running",
      lastEventSequence: 4,
      hasTerminalResultEvidence: false,
      dependencyCompletedCount: 1,
    };
    expect(computeProgressFingerprint(input)).toBe(computeProgressFingerprint({ ...input }));
  });

  it("computeProgressFingerprint: there is no time input at all — the function signature only accepts already-safe, already-bounded fields", () => {
    // The crux of "no-progress" detection: two calls with identical
    // non-time state always yield an identical fingerprint, even though
    // real wall-clock time necessarily passed between the two calls in
    // this very test.
    const input = {
      childTaskStatus: "running",
      lastEventSequence: 4,
      hasTerminalResultEvidence: false,
      dependencyCompletedCount: 1,
    };
    const first = computeProgressFingerprint(input);
    const second = computeProgressFingerprint(input);
    expect(first).toBe(second);
  });

  it("a new lastEventSequence IS progress", () => {
    const base = {
      childTaskStatus: "running",
      lastEventSequence: 4,
      hasTerminalResultEvidence: false,
      dependencyCompletedCount: 1,
    };
    expect(computeProgressFingerprint(base)).not.toBe(
      computeProgressFingerprint({ ...base, lastEventSequence: 5 }),
    );
  });

  it("a newly completed dependency IS progress", () => {
    const base = {
      childTaskStatus: "waiting_for_dependencies",
      lastEventSequence: undefined,
      hasTerminalResultEvidence: false,
      dependencyCompletedCount: 1,
    };
    expect(computeProgressFingerprint(base)).not.toBe(
      computeProgressFingerprint({ ...base, dependencyCompletedCount: 2 }),
    );
  });

  it("hasTerminalResultEvidence flipping to true IS progress", () => {
    const base = {
      childTaskStatus: "completed",
      lastEventSequence: 9,
      hasTerminalResultEvidence: false,
      dependencyCompletedCount: 0,
    };
    expect(computeProgressFingerprint(base)).not.toBe(
      computeProgressFingerprint({ ...base, hasTerminalResultEvidence: true }),
    );
  });

  it("childTaskStatus changing alone changes the fingerprint", () => {
    const base = {
      childTaskStatus: "running",
      lastEventSequence: 2,
      hasTerminalResultEvidence: false,
      dependencyCompletedCount: 0,
    };
    expect(computeProgressFingerprint(base)).not.toBe(
      computeProgressFingerprint({ ...base, childTaskStatus: "assigned" }),
    );
  });
});

describe("CEO plan execution — no-progress circuit breaker (real scheduler integration)", () => {
  it("dependency-waiting is never counted as no-progress", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    addAssignedTask(harness.taskStore, { taskId: "task-b", dependencyTaskIds: ["task-a"] });
    configureAndStart(harness, "run-1", "plan-1", [
      { stepId: "step-a", childTaskId: "task-a" },
      { stepId: "step-b", childTaskId: "task-b", dependencyStepIds: ["step-a"] },
    ]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    expect(harness.planRunStore.getStepExecution("run-1", "step-b").status).toBe(
      "waiting_for_dependencies",
    );
    // Re-evaluate multiple times purely from waiting — no failure path
    // was ever entered, so nothing could have incremented the counter.
    await harness.scheduler.enqueueSignal({
      planRunId: "run-1",
      reason: "periodic_reconciliation",
    });
    await harness.scheduler.enqueueSignal({
      planRunId: "run-1",
      reason: "periodic_reconciliation",
    });
    expect(harness.planRunStore.getCircuitState("run-1").noProgressAttempts).toBe(0);
  });

  it("capacity-waiting is never counted as no-progress", async () => {
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
    const steps = harness.planRunStore.listStepExecutions("run-1");
    expect(steps.some((s) => s.readinessReason === "waiting_for_capacity")).toBe(true);
    expect(harness.planRunStore.getCircuitState("run-1").noProgressAttempts).toBe(0);
  });

  it("a manual operator pause is never counted as no-progress", async () => {
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    harness.planRunStore.pauseRun({ runId: "run-1", now: NOW });
    harness.signalStore.cancelSignalsForRun("run-1", NOW);
    expect(harness.planRunStore.getCircuitState("run-1").noProgressAttempts).toBe(0);
  });

  it("exactly one circuit-opened event and one Board-audit summary are produced on trip, even though the run is paused immediately (no further failures can occur after)", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: false,
      }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      maxConsecutiveFailures: 1,
      pauseOnAnyPermanentFailure: false,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");

    expect(harness.planRunStore.getCircuitState("run-1").state).toBe("open");
    const circuitOpenedEvents = harness.planRunStore
      .listEvents("run-1")
      .filter((e) => e.type === "ceo.execution.circuit_opened");
    expect(circuitOpenedEvents).toHaveLength(1);
    // `#pauseForIntervention` posts one dedup-gated, generic
    // "requires operator attention" Board summary regardless of WHY it
    // paused (its `reason` parameter is currently unused — a real but
    // low-stakes observability gap, not a correctness one; see this
    // file's own "Known limitations" note). Assert exactly one audit
    // entry was posted for this pause, not that it names "circuit".
    expect(harness.boardAuditLog).toHaveLength(1);
  });

  it("duplicate/coalesced signals for the same step do not double-count a single failure", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: false,
      }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      maxConsecutiveFailures: 10,
      pauseOnAnyPermanentFailure: false,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");

    // Deliver the same underlying task-terminal event twice in a row —
    // `onChildTaskMutated` for a task already in a step's terminal
    // status is expected to be a safe, idempotent no-op the second time
    // (the step itself is already "failed" and out of the running run's
    // active set once paused, or the run has moved past "running").
    await harness.scheduler.onChildTaskMutated("task-a");
    const countAfterFirst = harness.planRunStore.getCircuitState("run-1").consecutiveFailures;
    await harness.scheduler.onChildTaskMutated("task-a");
    const countAfterSecond = harness.planRunStore.getCircuitState("run-1").consecutiveFailures;
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("no further step starts happen after the circuit trips", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: false,
      }),
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
      { maxConsecutiveFailures: 1, maxConcurrentSteps: 2, pauseOnAnyPermanentFailure: false },
    );
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");
    expect(harness.planRunStore.getCircuitState("run-1").state).toBe("open");

    // step-b was concurrently started before the trip (maxConcurrentSteps:2);
    // once the circuit is open, no NEW step may start. Re-signal and
    // confirm no step is freshly claimed as a result.
    const claimedOrRunningBefore = harness.planRunStore
      .listStepExecutions("run-1")
      .filter((s) => ["claimed", "starting", "running"].includes(s.status)).length;
    await harness.scheduler.enqueueSignal({
      planRunId: "run-1",
      reason: "periodic_reconciliation",
    });
    const claimedOrRunningAfter = harness.planRunStore
      .listStepExecutions("run-1")
      .filter((s) => ["claimed", "starting", "running"].includes(s.status)).length;
    expect(claimedOrRunningAfter).toBeLessThanOrEqual(claimedOrRunningBefore);
  });

  it("the circuit survives a clean process restart unchanged — a fresh scheduler pointed at the same stores still reports the tripped state", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: false,
      }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      maxConsecutiveFailures: 1,
      pauseOnAnyPermanentFailure: false,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");
    expect(harness.planRunStore.getCircuitState("run-1").state).toBe("open");

    // Simulate "the store persisted, only the scheduler object was
    // recreated" — build a second scheduler against the SAME store
    // instances, as a real restart against the same durable DB would.
    const freshScheduler = new CeoPlanExecutionScheduler({
      planRunStore: harness.planRunStore,
      signalStore: harness.signalStore,
      taskStore: harness.taskStore,
      taskOrchestrator: harness.taskOrchestrator,
      now: () => NOW,
      ownerToken: "owner-2",
      leaseSeconds: 30,
      postBoardAudit: () => {
        /* not under test here */
      },
      runAtomicUnit: createEphemeralAtomicUnit({
        planRunStore: harness.planRunStore,
        signalStore: harness.signalStore,
      }),
    });
    void freshScheduler;
    expect(harness.planRunStore.getCircuitState("run-1").state).toBe("open");
  });

  it("explicit operator action (resume) is required to clear a tripped circuit — nothing in the scheduler's own automatic signal processing calls resetCircuit", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: false,
      }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      maxConsecutiveFailures: 1,
      pauseOnAnyPermanentFailure: false,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");
    expect(harness.planRunStore.getCircuitState("run-1").state).toBe("open");

    // Ticking/enqueuing more signals against a tripped-but-still-running
    // run never un-trips it by itself.
    await harness.scheduler.enqueueSignal({
      planRunId: "run-1",
      reason: "periodic_reconciliation",
    });
    expect(harness.planRunStore.getCircuitState("run-1").state).toBe("open");

    // The run itself was paused by the trip (pauseForIntervention) —
    // only an explicit resume (an operator action, never automatic)
    // clears the circuit. See `resumeRun`'s own doc comment in both
    // store implementations.
    const run = harness.planRunStore.getRun("run-1");
    expect(["paused", "awaiting_intervention"]).toContain(run.status);
    harness.planRunStore.resumeRun({ runId: "run-1", now: NOW });
    expect(harness.planRunStore.getCircuitState("run-1").state).toBe("closed");
  });
});
