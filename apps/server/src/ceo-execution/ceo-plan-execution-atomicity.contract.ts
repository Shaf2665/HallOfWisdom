import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { MockAgentAdapter } from "@hall-of-wisdom/mock-agent";
import type { AgentAdapter } from "@hall-of-wisdom/agent-adapter-sdk";
import { DEFAULT_CEO_PLAN_EXECUTION_POLICY } from "@hall-of-wisdom/protocol";
import { TaskStore } from "../tasks/task-store.js";
import { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import { waitUntil } from "../test-support.js";
import type { CeoPlanRunStorePort } from "./ceo-plan-run-store-port.js";
import type { ExecutionSignalStorePort } from "./execution-signal-store-port.js";
import { CeoPlanExecutionScheduler } from "./ceo-plan-execution-scheduler.js";
import { PlanRunEventBus } from "./plan-run-event-bus.js";

const WORKSPACE_ROOT = process.cwd();
const NOW = "2026-07-31T12:00:00.000Z";

/**
 * Phase 15.1 kickoff §8 — the ephemeral cross-store atomicity contract,
 * run once against an ephemeral harness (in-memory stores +
 * `createEphemeralAtomicUnit`) and once against a durable harness (real
 * SQLite stores + `withTransaction`), mirroring
 * `ceo-plan-delegation-atomicity.contract.ts`'s own established pattern
 * for the same kind of proof on a different subsystem.
 *
 * Scoped deliberately to every REAL cross-store atomic span the scheduler
 * and REST routes actually open (`grep -n "runAtomicUnit(" across both
 * files) — not every operation the kickoff names individually, several of
 * which collapse into the same span:
 *   - "step-runtime transition", "retry scheduling", and "circuit
 *     opening" are three possible OUTCOMES of the one atomic span in
 *     `#handleChildTaskFailure` — covered by three tests below, one per
 *     outcome, all exercising that same span.
 *   - "signal insert/coalescing" during a step completion is covered by
 *     `onChildTaskMutated`'s completed-branch span; the cancelled branch
 *     gets its own test since it has a different conditional body.
 *   - "pause"/"cancel"/emergency-stop all share one shape
 *     (`{pauseRun|cancelRun|recoveryPauseRun} + cancelSignalsForRun`) —
 *     represented by two tests below (`#pauseForIntervention` and
 *     `emergencyStop`) covering two distinct call sites of that shape.
 *   - "attempt creation" is `claimAttempt`, called from
 *     `#tryAdvanceStep` — until this session this call was NOT wrapped in
 *     `runAtomicUnit` at all (a real, disclosed gap: `claimAttempt`
 *     internally performs two writes with no rollback of its own in
 *     ephemeral mode — see `CeoPlanRunStorePort.claimAttempt`'s doc
 *     comment). This is the one production code change kickoff §8 asks
 *     for; see `ceo-plan-execution-scheduler.ts`'s `#tryAdvanceStep`.
 *   - "signal claim" (`claimNext`), "Board-message append"
 *     (`claimBoardAuditOnce`), and "intervention append"
 *     (`recordIntervention`) are each a SINGLE store's SINGLE write, never
 *     spanned across stores by any real call site — their atomicity is
 *     each store's own single-operation guarantee, already proven by
 *     `execution-signal-store.{ephemeral,durable}.test.ts` and
 *     `ceo-plan-run-store.{ephemeral,durable}.test.ts`'s own contract
 *     suites, not a cross-store gap this file needs to re-derive.
 *
 * Every test also asserts the §3-adjacent guarantee: a rejected mutation
 * publishes nothing to `PlanRunEventBus` — `#appendEvent` is only ever
 * called strictly after its preceding atomic span commits (see that
 * method's own doc comment), so a rolled-back span structurally cannot
 * reach it, proven here by subscribing before the injected failure.
 */
export interface ExecutionAtomicityHarness {
  readonly taskStore: TaskStore;
  readonly taskOrchestrator: TaskOrchestrator;
  readonly planRunStore: CeoPlanRunStorePort;
  readonly signalStore: ExecutionSignalStorePort;
  readonly scheduler: CeoPlanExecutionScheduler;
  readonly planRunEventBus: PlanRunEventBus;
  readonly boardAuditLog: string[];
}

export function buildExecutionAtomicityHarnessDeps(
  planRunStore: CeoPlanRunStorePort,
  signalStore: ExecutionSignalStorePort,
  runAtomicUnit: <T>(fn: () => T) => T,
  adapter: AgentAdapter = new MockAgentAdapter({ scenario: "success", stepDelayMs: 0 }),
): ExecutionAtomicityHarness {
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
    workspaceRoot: WORKSPACE_ROOT,
  });
  const boardAuditLog: string[] = [];
  const planRunEventBus = new PlanRunEventBus({ maxSubscribersPerRun: 20 });
  const scheduler = new CeoPlanExecutionScheduler({
    planRunStore,
    signalStore,
    taskStore,
    taskOrchestrator,
    now: () => NOW,
    ownerToken: "owner-1",
    postBoardAudit: (_planId, text) => boardAuditLog.push(text),
    runAtomicUnit,
    eventBus: planRunEventBus,
  });
  return {
    taskStore,
    taskOrchestrator,
    planRunStore,
    signalStore,
    scheduler,
    planRunEventBus,
    boardAuditLog,
  };
}

function addAssignedTask(
  taskStore: TaskStore,
  taskId: string,
  adapterId = "hall.mock-agent",
): void {
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
    adapterId,
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

function configureAndStart(
  harness: ExecutionAtomicityHarness,
  runId: string,
  planId: string,
  stepId: string,
  childTaskId: string,
  policyOverrides: Partial<typeof DEFAULT_CEO_PLAN_EXECUTION_POLICY> = {},
): void {
  harness.planRunStore.configureRun({
    runId,
    planId,
    planVersion: 1,
    executionMode: "autonomous",
    policy: { ...DEFAULT_CEO_PLAN_EXECUTION_POLICY, ...policyOverrides },
    now: NOW,
    steps: [{ stepId, childTaskId, dependencyStepIds: [] }],
  });
  harness.scheduler.registerDependencyIndex(runId, [{ id: stepId, dependencies: [] }]);
  harness.planRunStore.startRun({ runId, now: NOW });
}

export function runCeoPlanExecutionAtomicityContractTests(
  label: string,
  buildHarness: (adapter?: AgentAdapter) => ExecutionAtomicityHarness,
): void {
  describe(`CEO plan execution ephemeral cross-store atomicity contract — ${label}`, () => {
    it("signal insert/coalescing during a step completion: an injected signal-store failure leaves the step NOT completed, no event, no publish, and a retry succeeds exactly once", async () => {
      const harness = buildHarness();
      addAssignedTask(harness.taskStore, "task-a");
      configureAndStart(harness, "run-1", "plan-1", "step-a", "task-a");
      const published: string[] = [];
      harness.planRunEventBus.subscribe("run-1", (event) => published.push(event.type));

      await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
      await waitUntil(() => harness.taskStore.get("task-a").task.status === "completed");

      const stepBefore = harness.planRunStore.getStepExecution("run-1", "step-a");
      const originalEnqueue = harness.signalStore.enqueue.bind(harness.signalStore);
      harness.signalStore.enqueue = () => {
        throw new Error("injected signal-store failure");
      };
      await expect(harness.scheduler.onChildTaskMutated("task-a")).rejects.toThrow(
        "injected signal-store failure",
      );

      const stepAfter = harness.planRunStore.getStepExecution("run-1", "step-a");
      expect(stepAfter.status).toBe(stepBefore.status);
      expect(
        harness.planRunStore
          .listEvents("run-1")
          .filter((e) => e.type === "ceo.execution.step_completed"),
      ).toHaveLength(0);
      expect(published).not.toContain("ceo.execution.step_completed");

      harness.signalStore.enqueue = originalEnqueue;
      await harness.scheduler.onChildTaskMutated("task-a");
      expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("completed");
      expect(
        harness.planRunStore
          .listEvents("run-1")
          .filter((e) => e.type === "ceo.execution.step_completed"),
      ).toHaveLength(1);
      expect(published).toContain("ceo.execution.step_completed");
    });

    it("task cancellation branch: an injected signal-store failure leaves the step NOT marked cancelled, no event, no publish", async () => {
      const harness = buildHarness();
      addAssignedTask(harness.taskStore, "task-a");
      // `pauseOnAnyPermanentFailure` defaults to `true`, which would
      // skip the signal-enqueue call this test injects a failure into —
      // disabled explicitly so that call is genuinely reached.
      configureAndStart(harness, "run-1", "plan-1", "step-a", "task-a", {
        pauseOnAnyPermanentFailure: false,
      });
      const published: string[] = [];
      harness.planRunEventBus.subscribe("run-1", (event) => published.push(event.type));

      await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
      await waitUntil(() => harness.taskStore.get("task-a").runId !== undefined);
      harness.taskStore.setCancellationRequested("task-a");
      harness.taskStore.updateStatus("task-a", "cancelled");

      const stepBefore = harness.planRunStore.getStepExecution("run-1", "step-a");
      const publishedBeforeFailure = published.length;
      const originalEnqueue = harness.signalStore.enqueue.bind(harness.signalStore);
      harness.signalStore.enqueue = () => {
        throw new Error("injected signal-store failure");
      };
      await expect(harness.scheduler.onChildTaskMutated("task-a")).rejects.toThrow(
        "injected signal-store failure",
      );

      const stepAfter = harness.planRunStore.getStepExecution("run-1", "step-a");
      expect(stepAfter.status).toBe(stepBefore.status);
      expect(
        harness.planRunStore
          .listEvents("run-1")
          .filter((e) => e.type === "ceo.execution.step_failed"),
      ).toHaveLength(0);
      // No NEW publish from the rejected span — legitimate earlier
      // publishes (task start) are untouched.
      expect(published).toHaveLength(publishedBeforeFailure);

      harness.signalStore.enqueue = originalEnqueue;
      await harness.scheduler.onChildTaskMutated("task-a");
      expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("cancelled");
    });

    it("step-runtime transition + retry scheduling: an injected circuit-state failure leaves the step NOT in retry_wait, no event, no publish, and a retry succeeds exactly once", async () => {
      const harness = buildHarness(
        new MockAgentAdapter({ scenario: "failure", stepDelayMs: 0, failureRetryable: true }),
      );
      addAssignedTask(harness.taskStore, "task-a");
      configureAndStart(harness, "run-1", "plan-1", "step-a", "task-a", {
        allowAutomaticTransientRetry: true,
        maxAttemptsPerStep: 3,
        retryBackoffSeconds: 30,
        pauseOnAnyPermanentFailure: false,
        maxConsecutiveFailures: 10,
        maxNoProgressAttempts: 10,
      });
      await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
      await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");

      const published: string[] = [];
      harness.planRunEventBus.subscribe("run-1", (event) => published.push(event.type));
      const stepBefore = harness.planRunStore.getStepExecution("run-1", "step-a");

      const originalRecordCircuitOutcome = harness.planRunStore.recordCircuitOutcome.bind(
        harness.planRunStore,
      );
      harness.planRunStore.recordCircuitOutcome = () => {
        throw new Error("injected circuit-store failure");
      };
      await expect(harness.scheduler.onChildTaskMutated("task-a")).rejects.toThrow(
        "injected circuit-store failure",
      );

      const stepAfter = harness.planRunStore.getStepExecution("run-1", "step-a");
      expect(stepAfter.status).toBe(stepBefore.status);
      expect(stepAfter.status).not.toBe("retry_wait");
      expect(
        harness.planRunStore
          .listEvents("run-1")
          .filter((e) => e.type === "ceo.execution.step_failed"),
      ).toHaveLength(0);
      expect(published).toHaveLength(0);

      harness.planRunStore.recordCircuitOutcome = originalRecordCircuitOutcome;
      await harness.scheduler.onChildTaskMutated("task-a");
      expect(harness.planRunStore.getStepExecution("run-1", "step-a").status).toBe("retry_wait");
      expect(
        harness.planRunStore
          .listEvents("run-1")
          .filter((e) => e.type === "ceo.execution.retry_scheduled"),
      ).toHaveLength(1);
    });

    it("circuit opening: an injected circuit-state failure leaves the circuit closed and the run NOT paused, no event, no publish, and a retry succeeds exactly once", async () => {
      const harness = buildHarness(
        new MockAgentAdapter({ scenario: "failure", stepDelayMs: 0, failureRetryable: false }),
      );
      addAssignedTask(harness.taskStore, "task-a");
      configureAndStart(harness, "run-1", "plan-1", "step-a", "task-a", {
        allowAutomaticTransientRetry: false,
        pauseOnAnyPermanentFailure: false,
        maxConsecutiveFailures: 1,
        maxNoProgressAttempts: 10,
      });
      await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
      await waitUntil(() => harness.taskStore.get("task-a").task.status === "failed");

      const published: string[] = [];
      harness.planRunEventBus.subscribe("run-1", (event) => published.push(event.type));

      const publishedBeforeFailure = published.length;
      const originalRecordCircuitOutcome = harness.planRunStore.recordCircuitOutcome.bind(
        harness.planRunStore,
      );
      harness.planRunStore.recordCircuitOutcome = () => {
        throw new Error("injected circuit-store failure");
      };
      await expect(harness.scheduler.onChildTaskMutated("task-a")).rejects.toThrow(
        "injected circuit-store failure",
      );

      expect(harness.planRunStore.getCircuitState("run-1").state).toBe("closed");
      expect(harness.planRunStore.getRun("run-1").status).toBe("running");
      expect(
        harness.planRunStore
          .listEvents("run-1")
          .filter((e) => e.type === "ceo.execution.circuit_opened"),
      ).toHaveLength(0);
      expect(published).toHaveLength(publishedBeforeFailure);

      harness.planRunStore.recordCircuitOutcome = originalRecordCircuitOutcome;
      await harness.scheduler.onChildTaskMutated("task-a");
      expect(harness.planRunStore.getCircuitState("run-1").state).toBe("open");
      // A circuit trip pauses via `recoveryPauseRun`, distinct from the
      // operator-initiated `pauseRun` (which `emergencyStop`'s own test
      // below exercises) — see `CeoPlanRunStatus`'s `"awaiting_intervention"`.
      expect(harness.planRunStore.getRun("run-1").status).toBe("awaiting_intervention");
      expect(
        harness.planRunStore
          .listEvents("run-1")
          .filter((e) => e.type === "ceo.execution.circuit_opened"),
      ).toHaveLength(1);
    });

    it("attempt creation: an injected step-execution failure during claimAttempt leaves NO dangling attempt row, and a retry succeeds exactly once (the gap this phase closed — claimAttempt is now wrapped in the atomic unit)", async () => {
      const harness = buildHarness();
      addAssignedTask(harness.taskStore, "task-a");
      configureAndStart(harness, "run-1", "plan-1", "step-a", "task-a");

      const attemptsBefore = harness.planRunStore.listAttempts("run-1").length;
      const originalUpsert = harness.planRunStore.upsertStepExecution.bind(harness.planRunStore);
      let injected = false;
      harness.planRunStore.upsertStepExecution = (input) => {
        if (!injected) {
          injected = true;
          throw new Error("injected step-execution failure");
        }
        return originalUpsert(input);
      };

      // `#processSignal`/`tick`/`#drain` have no catch of their own, so
      // the injected failure propagates all the way out of
      // `enqueueSignal` itself — proving the rejection reaches the
      // caller is part of the same guarantee as the state check below.
      await expect(
        harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" }),
      ).rejects.toThrow("injected step-execution failure");
      expect(harness.planRunStore.listAttempts("run-1")).toHaveLength(attemptsBefore);
      expect(harness.taskStore.get("task-a").runId).toBeUndefined();

      harness.planRunStore.upsertStepExecution = originalUpsert;
      await harness.scheduler.enqueueSignal({
        planRunId: "run-1",
        reason: "adapter_availability_changed",
      });
      await waitUntil(() => harness.taskStore.get("task-a").runId !== undefined);
      expect(harness.planRunStore.listAttempts("run-1")).toHaveLength(attemptsBefore + 1);
    });

    it("pause (via #pauseForIntervention, triggered by a cancelled child task under pauseOnAnyPermanentFailure): an injected signal-store failure leaves the run NOT paused (no partial pause state)", async () => {
      // No "retry succeeds" half here, unlike the other tests in this
      // file: `#pauseForIntervention` is a SEPARATE atomic span called
      // strictly AFTER the precipitating step-execution write already
      // committed (the step is genuinely "cancelled" by this point), so
      // `onChildTaskMutated`'s own per-task idempotency guard (never
      // reprocess an already-terminal step) makes a second call on the
      // SAME task a legitimate no-op, not a real retry path — that
      // "retry succeeds exactly once" guarantee for this exact span
      // shape (`recoveryPauseRun` + `cancelSignalsForRun`) is proven
      // instead by the "circuit opening" test below and by
      // `emergencyStop`'s test (`pauseRun` + `cancelSignalsForRun`),
      // both of which retry via a fresh precipitating event rather than
      // replaying an already-consumed one.
      const harness = buildHarness();
      addAssignedTask(harness.taskStore, "task-a");
      configureAndStart(harness, "run-1", "plan-1", "step-a", "task-a", {
        pauseOnAnyPermanentFailure: true,
      });
      await harness.scheduler.enqueueSignal({ planRunId: "run-1", reason: "execution_started" });
      await waitUntil(() => harness.taskStore.get("task-a").runId !== undefined);
      harness.taskStore.setCancellationRequested("task-a");
      harness.taskStore.updateStatus("task-a", "cancelled");

      const originalCancel = harness.signalStore.cancelSignalsForRun.bind(harness.signalStore);
      harness.signalStore.cancelSignalsForRun = () => {
        throw new Error("injected signal-store failure");
      };
      await expect(harness.scheduler.onChildTaskMutated("task-a")).rejects.toThrow(
        "injected signal-store failure",
      );
      expect(harness.planRunStore.getRun("run-1").status).toBe("running");
      harness.signalStore.cancelSignalsForRun = originalCancel;
    });

    it("emergency stop: an injected signal-store failure leaves the run NOT paused, and a retry succeeds exactly once", () => {
      const harness = buildHarness();
      addAssignedTask(harness.taskStore, "task-a");
      configureAndStart(harness, "run-1", "plan-1", "step-a", "task-a");

      const originalCancel = harness.signalStore.cancelSignalsForRun.bind(harness.signalStore);
      harness.signalStore.cancelSignalsForRun = () => {
        throw new Error("injected signal-store failure");
      };
      expect(() => harness.scheduler.emergencyStop("run-1")).toThrow(
        "injected signal-store failure",
      );
      expect(harness.planRunStore.getRun("run-1").status).toBe("running");

      harness.signalStore.cancelSignalsForRun = originalCancel;
      const result = harness.scheduler.emergencyStop("run-1");
      expect(harness.planRunStore.getRun("run-1").status).toBe("paused");
      expect(result.runId).toBe("run-1");
    });
  });
}
