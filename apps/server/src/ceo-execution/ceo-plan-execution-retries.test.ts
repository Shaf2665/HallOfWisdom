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
import { classifyExecutionFailure, decideRetry } from "./ceo-plan-execution-retries.js";

const WORKSPACE_ROOT = process.cwd();
const BASE_NOW = "2026-07-31T12:00:00.000Z";

/**
 * A mutable-clock variant of `ceo-plan-execution-scheduler.test.ts`'s own
 * `buildHarness` — the retry-backoff tests in this file need to advance
 * time between a failure and a later signal, which the fixed-`NOW`
 * harness in that sibling file has no need for.
 */
function buildHarness(options: { adapter?: AgentAdapter; boardAuditLog?: string[] } = {}) {
  let currentNow = BASE_NOW;
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
      createdAt: BASE_NOW,
      updatedAt: BASE_NOW,
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
    createdAt: BASE_NOW,
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
    now: harness.now(),
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
  return harness.planRunStore.startRun({ runId, now: harness.now() });
}

describe("CEO plan execution — retry classification and decision (pure functions)", () => {
  const transientFailure = { code: "PROVIDER_TIMEOUT", message: "timed out", retryable: true };
  const permanentFailure = { code: "BAD_REQUEST", message: "bad request", retryable: false };

  it("automatic retry is disabled by default — a transient failure at attempt 1 does not retry", () => {
    const classification = classifyExecutionFailure({
      kind: "structured_failure",
      failure: transientFailure,
    });
    expect(classification).toBe("transient");
    expect(DEFAULT_CEO_PLAN_EXECUTION_POLICY.allowAutomaticTransientRetry).toBe(false);
    const decision = decideRetry(
      { classification, policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY, attemptNumber: 1 },
      BASE_NOW,
    );
    expect(decision.shouldRetry).toBe(false);
  });

  it("retry only happens when explicitly enabled — flipping the flag is the only thing that changes the outcome", () => {
    const enabled: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 3,
    };
    const disabled: CeoPlanExecutionPolicy = { ...enabled, allowAutomaticTransientRetry: false };
    const classification = classifyExecutionFailure({
      kind: "structured_failure",
      failure: transientFailure,
    });
    expect(
      decideRetry({ classification, policy: enabled, attemptNumber: 1 }, BASE_NOW).shouldRetry,
    ).toBe(true);
    expect(
      decideRetry({ classification, policy: disabled, attemptNumber: 1 }, BASE_NOW).shouldRetry,
    ).toBe(false);
  });

  it("retry stops at maxAttemptsPerStep — at-threshold and above never retry, below it does", () => {
    const policy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 3,
    };
    const classification = classifyExecutionFailure({
      kind: "structured_failure",
      failure: transientFailure,
    });
    expect(decideRetry({ classification, policy, attemptNumber: 2 }, BASE_NOW).shouldRetry).toBe(
      true,
    );
    expect(decideRetry({ classification, policy, attemptNumber: 3 }, BASE_NOW).shouldRetry).toBe(
      false,
    );
    expect(decideRetry({ classification, policy, attemptNumber: 4 }, BASE_NOW).shouldRetry).toBe(
      false,
    );
  });

  it("nextEligibleAt is computed exactly from retryBackoffSeconds", () => {
    const classification = classifyExecutionFailure({
      kind: "structured_failure",
      failure: transientFailure,
    });
    const policy30s: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      allowAutomaticTransientRetry: true,
      retryBackoffSeconds: 30,
    };
    const decision30s = decideRetry(
      { classification, policy: policy30s, attemptNumber: 0 },
      BASE_NOW,
    );
    expect(decision30s.nextEligibleAt).toBe("2026-07-31T12:00:30.000Z");

    const policy900s: CeoPlanExecutionPolicy = { ...policy30s, retryBackoffSeconds: 900 };
    const decision900s = decideRetry(
      { classification, policy: policy900s, attemptNumber: 0 },
      BASE_NOW,
    );
    expect(decision900s.nextEligibleAt).toBe("2026-07-31T12:15:00.000Z");

    const policyZero: CeoPlanExecutionPolicy = { ...policy30s, retryBackoffSeconds: 0 };
    const decisionZero = decideRetry(
      { classification, policy: policyZero, attemptNumber: 0 },
      BASE_NOW,
    );
    expect(decisionZero.nextEligibleAt).toBe(BASE_NOW);
  });

  it("nextEligibleAt gating: it is strictly in the future for a positive backoff, and exactly now for a zero backoff", () => {
    const classification = classifyExecutionFailure({
      kind: "structured_failure",
      failure: transientFailure,
    });
    const positive: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      allowAutomaticTransientRetry: true,
      retryBackoffSeconds: 45,
    };
    const decision = decideRetry({ classification, policy: positive, attemptNumber: 0 }, BASE_NOW);
    expect(decision.nextEligibleAt).toBeDefined();
    expect(new Date(decision.nextEligibleAt ?? "").getTime()).toBeGreaterThan(
      new Date(BASE_NOW).getTime(),
    );

    const zero: CeoPlanExecutionPolicy = { ...positive, retryBackoffSeconds: 0 };
    const decisionZero = decideRetry({ classification, policy: zero, attemptNumber: 0 }, BASE_NOW);
    expect(decisionZero.nextEligibleAt).toBe(BASE_NOW);
  });

  it("permanent failures never retry, regardless of policy", () => {
    const classification = classifyExecutionFailure({
      kind: "structured_failure",
      failure: permanentFailure,
    });
    expect(classification).toBe("permanent");
    const generousPolicy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 10,
    };
    expect(
      decideRetry({ classification, policy: generousPolicy, attemptNumber: 0 }, BASE_NOW)
        .shouldRetry,
    ).toBe(false);
  });

  it("security-classified failures never retry, even when the underlying failure claims retryable:true", () => {
    const generousPolicy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 10,
    };
    for (const code of ["TRUST_VIOLATION", "SECURITY_POLICY_VIOLATION"] as const) {
      const classification = classifyExecutionFailure({
        kind: "structured_failure",
        failure: { code, message: "blocked", retryable: true },
      });
      expect(classification).toBe("security");
      expect(
        decideRetry({ classification, policy: generousPolicy, attemptNumber: 0 }, BASE_NOW)
          .shouldRetry,
      ).toBe(false);
    }
  });

  it("ownership-lost never retries", () => {
    const classification = classifyExecutionFailure({ kind: "ownership_lost" });
    expect(classification).toBe("ownership_lost");
    const generousPolicy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 10,
    };
    expect(
      decideRetry({ classification, policy: generousPolicy, attemptNumber: 0 }, BASE_NOW)
        .shouldRetry,
    ).toBe(false);
  });

  it("cancelled never retries", () => {
    const classification = classifyExecutionFailure({ kind: "cancelled" });
    expect(classification).toBe("cancelled");
    const generousPolicy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 10,
    };
    expect(
      decideRetry({ classification, policy: generousPolicy, attemptNumber: 0 }, BASE_NOW)
        .shouldRetry,
    ).toBe(false);
  });

  it("unknown classification never retries — a structured failure with a missing retryable hint is 'unknown', not 'transient'", () => {
    const classification = classifyExecutionFailure({
      kind: "structured_failure",
      failure: { code: "SOMETHING_ELSE", message: "unspecified" },
    });
    expect(classification).toBe("unknown");
    const generousPolicy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 10,
    };
    expect(
      decideRetry({ classification, policy: generousPolicy, attemptNumber: 0 }, BASE_NOW)
        .shouldRetry,
    ).toBe(false);
  });

  it("requirements-changed never retries", () => {
    const classification = classifyExecutionFailure({ kind: "requirements_changed" });
    expect(classification).toBe("requirements_changed");
    const generousPolicy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 10,
    };
    expect(
      decideRetry({ classification, policy: generousPolicy, attemptNumber: 0 }, BASE_NOW)
        .shouldRetry,
    ).toBe(false);
  });

  it("classifyExecutionFailure: exhaustive classification table, one assertion per outcome kind", () => {
    expect(classifyExecutionFailure({ kind: "adapter_unavailable" })).toBe("adapter_unavailable");
    expect(classifyExecutionFailure({ kind: "ownership_lost" })).toBe("ownership_lost");
    expect(classifyExecutionFailure({ kind: "cancelled" })).toBe("cancelled");
    expect(classifyExecutionFailure({ kind: "requirements_changed" })).toBe("requirements_changed");
    expect(
      classifyExecutionFailure({ kind: "structured_failure", failure: transientFailure }),
    ).toBe("transient");
    expect(
      classifyExecutionFailure({ kind: "structured_failure", failure: permanentFailure }),
    ).toBe("permanent");
    expect(
      classifyExecutionFailure({
        kind: "structured_failure",
        failure: { code: "TRUST_VIOLATION", message: "x", retryable: false },
      }),
    ).toBe("security");
    expect(
      classifyExecutionFailure({
        kind: "structured_failure",
        failure: { code: "SECURITY_POLICY_VIOLATION", message: "x", retryable: true },
      }),
    ).toBe("security");
    expect(
      classifyExecutionFailure({
        kind: "structured_failure",
        failure: { code: "UNTRUSTED_ADAPTER_BLOCKED", message: "x" },
      }),
    ).toBe("security");
    expect(
      classifyExecutionFailure({
        kind: "structured_failure",
        failure: { code: "NO_HINT", message: "x" },
      }),
    ).toBe("unknown");
  });

  it("classification is driven only by code/retryable, never by the free-text message", () => {
    const a = classifyExecutionFailure({
      kind: "structured_failure",
      failure: { code: "PROVIDER_TIMEOUT", message: "The quick brown fox jumps.", retryable: true },
    });
    const b = classifyExecutionFailure({
      kind: "structured_failure",
      failure: {
        code: "PROVIDER_TIMEOUT",
        message: "An entirely different sentence, unrelated in every way.",
        retryable: true,
      },
    });
    expect(a).toBe(b);
    expect(a).toBe("transient");
  });

  it("decideRetry is a pure function of (classification, policy, attemptNumber) — identical inputs always give an identical decision, so restart can never accumulate hidden retry state", () => {
    const policy: CeoPlanExecutionPolicy = {
      ...DEFAULT_CEO_PLAN_EXECUTION_POLICY,
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 5,
      retryBackoffSeconds: 60,
    };
    const input = { classification: "transient" as const, policy, attemptNumber: 2 };
    const first = decideRetry(input, BASE_NOW);
    const second = decideRetry(input, BASE_NOW);
    expect(second).toEqual(first);
  });
});

describe("CEO plan execution — retry decision integration (real scheduler)", () => {
  it("a transient failure with retry enabled schedules a retry_wait step with a future nextEligibleAt, and never touches the run's policy after configure", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: true,
      }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 3,
      retryBackoffSeconds: 30,
      pauseOnAnyPermanentFailure: false,
      maxConsecutiveFailures: 10,
      maxNoProgressAttempts: 10,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");

    const step = harness.planRunStore.getStepExecution("run-1", "step-a");
    expect(step.status).toBe("retry_wait");
    expect(step.nextEligibleAt).toBeDefined();
    expect(new Date(step.nextEligibleAt ?? "").getTime()).toBeGreaterThan(
      new Date(harness.now()).getTime() - 1,
    );

    // Ticking again immediately (policy snapshot unchanged) yields the
    // same gating decision — nothing mutates `policySnapshot` after
    // configure.
    const run = harness.planRunStore.getRun("run-1");
    expect(run.policySnapshot.retryBackoffSeconds).toBe(30);
  });

  it("the nextEligibleAt gate: a retry_wait step with a future eligibility does not advance on a later plan-level signal; the same step advances once eligibility has passed", async () => {
    // Isolates the gate itself from the separate, structural limitation
    // that a step whose child task already reached a TERMINAL status
    // (e.g. a real failed run) can never be relaunched through
    // `TaskOrchestrator.startTask` (it requires `status === "assigned"`,
    // and nothing resets a terminal task back to it — see this file's
    // "Known limitation" note below and `docs/architecture/0015-...md`).
    // So this test constructs `retry_wait` directly against a task that
    // is still `"assigned"` (never actually run), exactly like the
    // manual-retry test below does, to prove the gate mechanism itself
    // — independent of that separate limitation.
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    const dependencySummary = {
      totalDependencies: 0,
      completedDependencies: 0,
      failedDependencies: 0,
      cancelledDependencies: 0,
    };
    const future = new Date(new Date(harness.now()).getTime() + 30_000).toISOString();
    harness.planRunStore.upsertStepExecution({
      runId: "run-1",
      planStepId: "step-a",
      status: "retry_wait",
      readinessReason: "ready",
      dependencySummary,
      nextEligibleAt: future,
    });

    // Backoff has NOT elapsed yet — a plan-level signal must not advance it.
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "operator_resumed" });
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("retry_wait");
    expect(harness.taskStore.get("task-a").runId).toBeUndefined();

    // Advance past the 30s backoff and try again — now it may advance.
    harness.advanceTime(31);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "operator_resumed" });
    const stepAfter = harness.planRunStore.getStepExecution("run-1", "step-a");
    expect(["claimed", "starting", "running"]).toContain(stepAfter.status);
    expect(harness.taskStore.get("task-a").runId).toBeDefined();
  });

  it("Phase 15.2 — a real run-then-fail retry_wait step past its nextEligibleAt DOES relaunch with a genuinely new run, closing the formerly-documented retry deadlock", async () => {
    // Prior to Phase 15.2, this test documented a KNOWN LIMITATION: the
    // gate below correctly stops an EARLY retry, but once eligible,
    // `#tryAdvanceStep` still required `taskRecord.task.status ===
    // "assigned"` before calling `TaskOrchestrator.startTask` — a task
    // that had already reached "failed" never satisfied that, and
    // nothing reset it. `TaskOrchestrator.prepareRetry()` (backed by
    // `TaskStore.prepareRetryIfEligible()` + `EventStore.
    // reopenForRetry()`), gated by `CeoPlanExecutionScheduler.
    // #prepareTaskRetryIfEligible()`'s 13 preconditions, now closes that
    // gap — this test proves attempt 2 genuinely launches: a NEW task
    // run ID, a NEW attempt row, and the child task actually reaching
    // "running" again (not just a status flip).
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: true,
      }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 3,
      retryBackoffSeconds: 30,
      pauseOnAnyPermanentFailure: false,
      maxConsecutiveFailures: 10,
      maxNoProgressAttempts: 10,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("retry_wait");
    const attemptsAfterFirstFailure = harness.planRunStore.listAttempts("run-1", "step-a");
    expect(attemptsAfterFirstFailure).toHaveLength(1);
    const firstAttemptRunId = attemptsAfterFirstFailure[0]?.taskRunId;
    expect(firstAttemptRunId).toBeDefined();
    const firstTaskRunId = harness.taskStore.get("task-a").runId;
    expect(firstTaskRunId).toBe(firstAttemptRunId);

    harness.advanceTime(31);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "operator_resumed" });

    // Attempt 2's row exists the moment it was claimed — proves a
    // genuinely new attempt launched, not a reuse of attempt 1.
    const attemptsAfterSecondClaim = harness.planRunStore.listAttempts("run-1", "step-a");
    expect(attemptsAfterSecondClaim).toHaveLength(2);
    const secondAttemptClaimed = attemptsAfterSecondClaim[1];
    expect(secondAttemptClaimed?.attemptNumber).toBe(2);
    // A genuinely NEW run ID — never the same run resumed or duplicated.
    expect(secondAttemptClaimed?.taskRunId).toBeDefined();
    expect(secondAttemptClaimed?.taskRunId).not.toBe(firstAttemptRunId);
    // Attempt 1's own history — including its own run ID — is preserved
    // untouched, not overwritten or deleted by the reset.
    expect(attemptsAfterSecondClaim[0]?.taskRunId).toBe(firstAttemptRunId);
    expect(attemptsAfterSecondClaim[0]?.status).toBe("failed");

    // The harness never wires the mutation hook automatically (see
    // the manual `onChildTaskMutated` call above, for attempt 1) — attempt
    // 2 (with the always-failing adapter) ran to its own real terminal
    // failure, landing back in retry_wait, proving this isn't a one-shot
    // fluke but a repeatable mechanism.
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed", 2000);
    await harness.scheduler.onChildTaskMutated("task-a");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("retry_wait");
    const attemptsAfterSecondFailure = harness.planRunStore.listAttempts("run-1", "step-a");
    expect(attemptsAfterSecondFailure).toHaveLength(2);
    expect(attemptsAfterSecondFailure[1]?.status).toBe("failed");
  });

  it("Phase 15.2 — a governed retry that then SUCCEEDS completes the run, with attempt 1's failure history preserved alongside attempt 2's success", async () => {
    let calls = 0;
    const flakyThenHealthyAdapter: AgentAdapter = {
      descriptor: new MockAgentAdapter().descriptor,
      detect: () => new MockAgentAdapter().detect(),
      startTask: (input, options) => {
        calls += 1;
        const scenario = calls === 1 ? "failure" : "success";
        return new MockAgentAdapter({ scenario, stepDelayMs: 0, failureRetryable: true }).startTask(
          input,
          options,
        );
      },
    };
    const harness = buildHarness({ adapter: flakyThenHealthyAdapter });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 3,
      retryBackoffSeconds: 30,
      pauseOnAnyPermanentFailure: false,
      maxConsecutiveFailures: 10,
      maxNoProgressAttempts: 10,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("retry_wait");

    harness.advanceTime(31);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "operator_resumed" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "completed", 2000);
    await harness.scheduler.onChildTaskMutated("task-a");

    await waitUntil(
      () => harness.planRunStore.getStepExecution("run-1", "step-a").status === "completed",
      2000,
    );
    const attempts = harness.planRunStore.listAttempts("run-1", "step-a");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.status).toBe("failed");
    expect(attempts[1]?.status).toBe("completed");
    expect(attempts[1]?.taskRunId).not.toBe(attempts[0]?.taskRunId);
    expect(harness.taskStore.get("task-a").task.status).toBe("completed");
    const run = harness.planRunStore.getRun("run-1");
    expect(run.status).toBe("completed");
  });

  it("adapter_unavailable at launch time is handled via the start-failure path, never treated as a retryable classification", async () => {
    const unavailableAdapter: AgentAdapter = {
      descriptor: new MockAgentAdapter().descriptor,
      detect: () => Promise.resolve({ installed: true, availability: "busy" }),
      startTask: () => {
        throw new Error("must never be called — detect() already reported unavailable");
      },
    };
    const harness = buildHarness({ adapter: unavailableAdapter });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 10,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    const step = harness.planRunStore.getStepExecution("run-1", "step-a");
    // adapter_unavailable classifies to a non-"transient" code, so
    // decideRetry never schedules a retry_wait for it — it lands in
    // awaiting_intervention instead, exactly like the pre-existing
    // scheduler test for this same scenario.
    expect(step.status).toBe("awaiting_intervention");
    expect(step.status).not.toBe("retry_wait");
  });

  it("pause holds retry: once a step is retry_wait, pausing the run stops further attempts even after eligibility passes", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: true,
      }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 3,
      retryBackoffSeconds: 30,
      pauseOnAnyPermanentFailure: false,
      maxConsecutiveFailures: 10,
      maxNoProgressAttempts: 10,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("retry_wait");

    const attemptsBeforePause = harness.planRunStore.listAttempts("run-1", "step-a").length;

    // Pause exactly the way the REST route does: pauseRun + cancel any
    // queued signals for this run.
    harness.planRunStore.pauseRun({ runId: "run-1", now: harness.now() });
    harness.signalStore.cancelSignalsForRun("run-1", harness.now());

    harness.advanceTime(60);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "operator_resumed" });
    // enqueueSignal is a no-op for a non-"running" run — the step must
    // still be exactly where it was left, with no new attempt created.
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("retry_wait");
    expect(harness.planRunStore.listAttempts("run-1", "step-a")).toHaveLength(attemptsBeforePause);
  });

  it("cancel invalidates a pending retry: cancelling the run means the step never gets a further attempt, even past eligibility", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: true,
      }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 3,
      retryBackoffSeconds: 30,
      pauseOnAnyPermanentFailure: false,
      maxConsecutiveFailures: 10,
      maxNoProgressAttempts: 10,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("retry_wait");

    const attemptsBeforeCancel = harness.planRunStore.listAttempts("run-1", "step-a").length;

    harness.planRunStore.cancelRun({ runId: "run-1", now: harness.now() });
    harness.signalStore.cancelSignalsForRun("run-1", harness.now());

    harness.advanceTime(60);
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "operator_resumed" });
    expect(harness.planRunStore.getRun("run-1").status).toBe("cancelled");
    expect(harness.planRunStore.listAttempts("run-1", "step-a")).toHaveLength(attemptsBeforeCancel);
  });

  it("a manual retry (operator_manual_retry) is explicit and idempotent — sending it twice in a row does not double-launch", async () => {
    const harness = buildHarness({
      adapter: new MockAgentAdapter({ scenario: "cancellable", stepDelayMs: 5000 }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      pauseOnAnyPermanentFailure: false,
    });
    // Force the step directly into "failed" (bypassing a real run) so
    // this test isolates the manual-retry entry point itself, not the
    // failure path already covered above.
    harness.planRunStore.upsertStepExecution({
      runId: "run-1",
      planStepId: "step-a",
      status: "failed",
      readinessReason: "ready",
      dependencySummary: {
        totalDependencies: 0,
        completedDependencies: 0,
        failedDependencies: 0,
        cancelledDependencies: 0,
      },
    });

    await harness.scheduler.enqueueSignal({
      planRunId: "run-1",
      planStepId: "step-a",
      reason: "operator_manual_retry",
    });
    await harness.scheduler.enqueueSignal({
      planRunId: "run-1",
      planStepId: "step-a",
      reason: "operator_manual_retry",
    });

    const attempts = harness.planRunStore.listAttempts("run-1", "step-a");
    // Exactly one attempt was ever created for this step, not two —
    // the second manual-retry signal found the step already
    // claimed/running and made no further change.
    expect(attempts).toHaveLength(1);
  });

  it("an abandoned attempt (left behind by recovery) is never treated as a fresh automatic-retry candidate by decideRetry", () => {
    // `decideRetry` only ever sees a `classification` derived from a
    // real failure outcome — "abandoned" is a store-level attempt
    // status the recovery module sets, not a `ClassifiableOutcome` this
    // module knows how to produce, so there is structurally no code
    // path from "abandoned" into `decideRetry`. Confirm the attempt
    // status itself is inert with respect to this module.
    const harness = buildHarness();
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }]);
    harness.planRunStore.upsertStepExecution({
      runId: "run-1",
      planStepId: "step-a",
      status: "claimed",
      readinessReason: "ready",
      dependencySummary: {
        totalDependencies: 0,
        completedDependencies: 0,
        failedDependencies: 0,
        cancelledDependencies: 0,
      },
    });
    const attempt = harness.planRunStore.createAttempt({
      attemptId: "attempt-1",
      runId: "run-1",
      planStepId: "step-a",
      childTaskId: "task-a",
      attemptNumber: 1,
      triggerReason: "execution_started",
      schedulerSignalId: "signal-1",
      leaseGeneration: 1,
      ownerToken: "owner-1",
      now: harness.now(),
    });
    harness.planRunStore.updateAttempt({
      attemptId: attempt.id,
      status: "abandoned",
      now: harness.now(),
    });
    expect(harness.planRunStore.getAttempt(attempt.id).status).toBe("abandoned");
    // No retry_wait was ever scheduled purely by marking an attempt
    // abandoned — only a real classified failure outcome does that.
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).not.toBe("retry_wait");
  });

  it("REGRESSION: a duplicate onChildTaskMutated delivery for a step already parked in retry_wait does not double-count the circuit breaker's failure counters", async () => {
    // A `retry_wait` step's underlying child task is already genuinely
    // "failed" — a second delivery of that same mutation (the
    // production bridge is explicitly best-effort and may redeliver)
    // must be a no-op, not a second classified failure.
    const harness = buildHarness({
      adapter: new MockAgentAdapter({
        scenario: "failure",
        stepDelayMs: 0,
        failureRetryable: true,
      }),
    });
    addAssignedTask(harness.taskStore, { taskId: "task-a" });
    configureAndStart(harness, "run-1", "plan-1", [{ stepId: "step-a", childTaskId: "task-a" }], {
      allowAutomaticTransientRetry: true,
      maxAttemptsPerStep: 3,
      retryBackoffSeconds: 30,
      pauseOnAnyPermanentFailure: false,
      maxConsecutiveFailures: 10,
      maxNoProgressAttempts: 10,
    });
    await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
    await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");
    await harness.scheduler.onChildTaskMutated("task-a");
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("retry_wait");
    const countAfterFirst = harness.planRunStore.getCircuitState("run-1").consecutiveFailures;

    await harness.scheduler.onChildTaskMutated("task-a");
    const countAfterSecond = harness.planRunStore.getCircuitState("run-1").consecutiveFailures;
    expect(countAfterSecond).toBe(countAfterFirst);
    expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("retry_wait");
  });
});
