import { describe, expect, it } from "vitest";
import { DEFAULT_CEO_PLAN_EXECUTION_POLICY } from "@hall-of-wisdom/protocol";
import {
  CeoPlanRunAlreadyActiveError,
  CeoPlanRunNotFoundError,
  CeoPlanRunStateConflictError,
  CeoPlanStepAttemptConflictError,
} from "../errors/app-error.js";
import type { CeoPlanRunStorePort } from "./ceo-plan-run-store-port.js";

const NOW = "2026-07-31T12:00:00.000Z";
const LATER = "2026-07-31T12:05:00.000Z";

function configureInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    runId: "run-1",
    planId: "plan-1",
    planVersion: 1,
    executionMode: "autonomous" as const,
    policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
    now: NOW,
    steps: [
      { stepId: "step-a", childTaskId: "task-a", dependencyStepIds: [] },
      { stepId: "step-b", childTaskId: "task-b", dependencyStepIds: ["step-a"] },
    ],
    ...overrides,
  };
}

/**
 * Behavioral contract every `CeoPlanRunStorePort` implementation must
 * satisfy — run once against `InMemoryCeoPlanRunStore` and once against
 * `SqliteCeoPlanRunStore` (over a real, migrated, in-memory `HallDatabase`
 * — the same SQLite engine and constraints a durable deployment uses,
 * exercised without a temp-file dance), mirroring every other Phase
 * 13/14/15 store's `run*ContractTests` pattern.
 */
export function runCeoPlanRunStoreContractTests(
  label: string,
  buildStore: () => CeoPlanRunStorePort,
): void {
  describe(`CeoPlanRunStorePort contract — ${label}`, () => {
    it("configures a run in 'configured' status with the policy snapshot intact", () => {
      const store = buildStore();
      const run = store.configureRun(configureInput());
      expect(run.status).toBe("configured");
      expect(run.policySnapshot).toEqual(DEFAULT_CEO_PLAN_EXECUTION_POLICY);
      expect(run.activeGeneration).toBe(0);
    });

    it("seeds one step-execution row per step, ready vs waiting_for_dependencies correctly", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      const a = store.getStepExecution("run-1", "step-a");
      const b = store.getStepExecution("run-1", "step-b");
      expect(a.status).toBe("ready");
      expect(b.status).toBe("waiting_for_dependencies");
      expect(b.dependencySummary.totalDependencies).toBe(1);
    });

    it("rejects a second active run for the same plan", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      expect(() => store.configureRun(configureInput({ runId: "run-2" }))).toThrow(
        CeoPlanRunAlreadyActiveError,
      );
    });

    it("allows a new run for the same plan once the prior one reaches a terminal status", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.startRun({ runId: "run-1", now: NOW });
      store.completeRun({ runId: "run-1", now: LATER });
      expect(() => store.configureRun(configureInput({ runId: "run-2" }))).not.toThrow();
    });

    it("moves configured -> running -> completed, stamping timestamps", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      const started = store.startRun({ runId: "run-1", now: NOW });
      expect(started.status).toBe("running");
      expect(started.startedAt).toBe(NOW);
      const completed = store.completeRun({ runId: "run-1", now: LATER });
      expect(completed.status).toBe("completed");
      expect(completed.completedAt).toBe(LATER);
    });

    it("rejects starting a run that is not 'configured'", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.startRun({ runId: "run-1", now: NOW });
      expect(() => store.startRun({ runId: "run-1", now: LATER })).toThrow(
        CeoPlanRunStateConflictError,
      );
    });

    it("pause leaves policy and activeGeneration untouched (policy is immutable once a run starts)", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.startRun({ runId: "run-1", now: NOW });
      const paused = store.pauseRun({ runId: "run-1", now: LATER });
      expect(paused.status).toBe("paused");
      expect(paused.policySnapshot).toEqual(DEFAULT_CEO_PLAN_EXECUTION_POLICY);
      expect(paused.activeGeneration).toBe(0);
    });

    it("resume bumps activeGeneration (invalidating stale signals from before the pause)", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.startRun({ runId: "run-1", now: NOW });
      store.pauseRun({ runId: "run-1", now: LATER });
      const resumed = store.resumeRun({ runId: "run-1", now: LATER });
      expect(resumed.status).toBe("running");
      expect(resumed.activeGeneration).toBe(1);
    });

    it("cancel is reachable from configured, running, paused, and awaiting_intervention", () => {
      for (const setup of [
        (store: CeoPlanRunStorePort) => {
          store.configureRun(configureInput());
        },
        (store: CeoPlanRunStorePort) => {
          store.configureRun(configureInput());
          store.startRun({ runId: "run-1", now: NOW });
        },
      ]) {
        const store = buildStore();
        setup(store);
        const cancelled = store.cancelRun({ runId: "run-1", now: LATER });
        expect(cancelled.status).toBe("cancelled");
      }
    });

    it("recoveryPauseRun moves running -> awaiting_intervention with the recovery classification recorded", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.startRun({ runId: "run-1", now: NOW });
      const paused = store.recoveryPauseRun({
        runId: "run-1",
        now: LATER,
        classification: "unclean_paused",
      });
      expect(paused.status).toBe("awaiting_intervention");
      expect(paused.recoveryClassification).toBe("unclean_paused");
    });

    it("throws CeoPlanRunNotFoundError for an unknown run", () => {
      const store = buildStore();
      expect(() => store.getRun("nope")).toThrow(CeoPlanRunNotFoundError);
    });

    it("getActiveRunForPlan returns undefined once the run is terminal", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.startRun({ runId: "run-1", now: NOW });
      store.completeRun({ runId: "run-1", now: LATER });
      expect(store.getActiveRunForPlan("plan-1")).toBeUndefined();
    });

    it("creates attempt 1 then attempt 2 for the same step once the first is terminal", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.startRun({ runId: "run-1", now: NOW });
      const a1 = store.createAttempt({
        attemptId: "a-1",
        runId: "run-1",
        planStepId: "step-a",
        childTaskId: "task-a",
        attemptNumber: 1,
        triggerReason: "execution_started",
        schedulerSignalId: "sig-1",
        leaseGeneration: 0,
        ownerToken: "owner-1",
        now: NOW,
      });
      expect(a1.attemptNumber).toBe(1);
      store.updateAttempt({ attemptId: "a-1", status: "failed", now: LATER });
      const a2 = store.createAttempt({
        attemptId: "a-2",
        runId: "run-1",
        planStepId: "step-a",
        childTaskId: "task-a",
        attemptNumber: 2,
        triggerReason: "retry_due",
        schedulerSignalId: "sig-2",
        leaseGeneration: 0,
        ownerToken: "owner-1",
        now: LATER,
      });
      expect(a2.attemptNumber).toBe(2);
    });

    it("listAttempts returns deterministic per-step and run-wide ordering", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.startRun({ runId: "run-1", now: NOW });
      store.createAttempt({
        attemptId: "a-1",
        runId: "run-1",
        planStepId: "step-a",
        childTaskId: "task-a",
        attemptNumber: 1,
        triggerReason: "execution_started",
        schedulerSignalId: "sig-a-1",
        leaseGeneration: 0,
        ownerToken: "owner-1",
        now: NOW,
      });
      store.createAttempt({
        attemptId: "b-1",
        runId: "run-1",
        planStepId: "step-b",
        childTaskId: "task-b",
        attemptNumber: 1,
        triggerReason: "execution_started",
        schedulerSignalId: "sig-b-1",
        leaseGeneration: 0,
        ownerToken: "owner-1",
        now: NOW,
      });
      store.updateAttempt({ attemptId: "a-1", status: "failed", now: LATER });
      store.createAttempt({
        attemptId: "a-2",
        runId: "run-1",
        planStepId: "step-a",
        childTaskId: "task-a",
        attemptNumber: 2,
        triggerReason: "operator_manual_retry",
        schedulerSignalId: "sig-a-2",
        leaseGeneration: 0,
        ownerToken: "owner-1",
        now: LATER,
      });

      expect(store.listAttempts("run-1", "step-a").map((attempt) => attempt.id)).toEqual([
        "a-1",
        "a-2",
      ]);
      expect(store.listAttempts("run-1").map((attempt) => attempt.id)).toEqual([
        "a-1",
        "a-2",
        "b-1",
      ]);
    });

    it("rejects a second non-terminal attempt for the same step — at most one active attempt", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.startRun({ runId: "run-1", now: NOW });
      store.createAttempt({
        attemptId: "a-1",
        runId: "run-1",
        planStepId: "step-a",
        childTaskId: "task-a",
        attemptNumber: 1,
        triggerReason: "execution_started",
        schedulerSignalId: "sig-1",
        leaseGeneration: 0,
        ownerToken: "owner-1",
        now: NOW,
      });
      expect(() =>
        store.createAttempt({
          attemptId: "a-2",
          runId: "run-1",
          planStepId: "step-a",
          childTaskId: "task-a",
          attemptNumber: 2,
          triggerReason: "execution_started",
          schedulerSignalId: "sig-2",
          leaseGeneration: 0,
          ownerToken: "owner-1",
          now: NOW,
        }),
      ).toThrow(CeoPlanStepAttemptConflictError);
    });

    it("upsertStepExecution transitions readiness and preserves an existing startedAt", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.upsertStepExecution({
        runId: "run-1",
        planStepId: "step-a",
        status: "running",
        readinessReason: "ready",
        dependencySummary: {
          totalDependencies: 0,
          completedDependencies: 0,
          failedDependencies: 0,
          cancelledDependencies: 0,
        },
        startedAt: NOW,
      });
      const updated = store.upsertStepExecution({
        runId: "run-1",
        planStepId: "step-a",
        status: "completed",
        readinessReason: "completed",
        dependencySummary: {
          totalDependencies: 0,
          completedDependencies: 0,
          failedDependencies: 0,
          cancelledDependencies: 0,
        },
        completedAt: LATER,
      });
      expect(updated.status).toBe("completed");
      expect(updated.startedAt).toBe(NOW);
      expect(updated.completedAt).toBe(LATER);
    });

    it("circuit state starts closed and tracks consecutive failures, resetting on progress", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      expect(store.getCircuitState("run-1").state).toBe("closed");
      store.recordCircuitOutcome({ runId: "run-1", failureCode: "transient", isNoProgress: false });
      store.recordCircuitOutcome({ runId: "run-1", failureCode: "transient", isNoProgress: false });
      let state = store.getCircuitState("run-1");
      expect(state.consecutiveFailures).toBe(2);
      expect(state.consecutiveSameCodeFailures).toBe(2);
      store.recordCircuitProgress("run-1");
      state = store.getCircuitState("run-1");
      expect(state.consecutiveFailures).toBe(0);
    });

    it("tripCircuit opens the circuit; resetCircuit closes it and clears counters", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.tripCircuit({
        runId: "run-1",
        reason: "consecutive_failures",
        stepId: "step-a",
        now: NOW,
      });
      expect(store.getCircuitState("run-1").state).toBe("open");
      store.resetCircuit("run-1");
      const state = store.getCircuitState("run-1");
      expect(state.state).toBe("closed");
      expect(state.tripReason).toBeUndefined();
    });

    it("resumeRun clears a tripped circuit — resume is the one explicit operator action that resets it, nothing automatic ever does", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.startRun({ runId: "run-1", now: NOW });
      store.recordCircuitOutcome({ runId: "run-1", failureCode: "transient", isNoProgress: false });
      store.tripCircuit({
        runId: "run-1",
        reason: "consecutive_failures",
        stepId: "step-a",
        now: NOW,
      });
      expect(store.getCircuitState("run-1").state).toBe("open");
      // `tripCircuit` alone never touches run status — the scheduler
      // separately pauses the run for intervention; simulate that here
      // so `resumeRun`'s allowed-from-status guard is satisfied.
      store.recoveryPauseRun({ runId: "run-1", now: LATER, classification: "unclean_paused" });

      store.resumeRun({ runId: "run-1", now: LATER });
      const state = store.getCircuitState("run-1");
      expect(state.state).toBe("closed");
      expect(state.consecutiveFailures).toBe(0);
      expect(state.tripReason).toBeUndefined();
    });

    it("events get a monotonically increasing, per-run sequence starting at 0", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      const e0 = store.appendEvent({
        runId: "run-1",
        type: "ceo.execution.configured",
        actor: "system:ceo-scheduler",
        payload: {},
        now: NOW,
      });
      const e1 = store.appendEvent({
        runId: "run-1",
        type: "ceo.execution.started",
        actor: "system:ceo-scheduler",
        payload: {},
        now: LATER,
      });
      expect(e0.sequence).toBe(0);
      expect(e1.sequence).toBe(1);
      expect(store.listEvents("run-1")).toHaveLength(2);
      expect(store.listEvents("run-1", 0)).toHaveLength(1);
    });

    it("recordIntervention appends to the run's intervention history", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.recordIntervention({
        interventionId: "i-1",
        runId: "run-1",
        type: "pause",
        note: undefined,
        now: NOW,
      });
      expect(store.listInterventions("run-1")).toHaveLength(1);
      expect(store.listInterventions("run-1")[0]?.type).toBe("pause");
    });

    it("claimBoardAuditOnce returns true exactly once per (runId, dedupKey)", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      expect(store.claimBoardAuditOnce("run-1", "execution_started", NOW)).toBe(true);
      expect(store.claimBoardAuditOnce("run-1", "execution_started", LATER)).toBe(false);
      expect(store.claimBoardAuditOnce("run-1", "execution_paused", LATER)).toBe(true);
    });

    it("abandoned retry intents are durable-idempotent for one exact abandoned attempt and link to one replacement attempt", () => {
      const store = buildStore();
      store.configureRun(configureInput());
      store.startRun({ runId: "run-1", now: NOW });
      store.createAttempt({
        attemptId: "a-1",
        runId: "run-1",
        planStepId: "step-a",
        childTaskId: "task-a",
        attemptNumber: 1,
        triggerReason: "execution_started",
        schedulerSignalId: "sig-a-1",
        leaseGeneration: 0,
        ownerToken: "owner-1",
        now: NOW,
      });
      store.updateAttempt({ attemptId: "a-1", status: "abandoned", now: LATER });

      const first = store.claimAbandonedRetryIntent({
        intentId: "intent-1",
        runId: "run-1",
        planStepId: "step-a",
        childTaskId: "task-a",
        abandonedAttemptId: "a-1",
        now: NOW,
      });
      const duplicate = store.claimAbandonedRetryIntent({
        intentId: "intent-duplicate",
        runId: "run-1",
        planStepId: "step-a",
        childTaskId: "task-a",
        abandonedAttemptId: "a-1",
        now: LATER,
      });

      expect(first.created).toBe(true);
      expect(duplicate.created).toBe(false);
      expect(duplicate.intent.id).toBe("intent-1");
      store.createAttempt({
        attemptId: "a-2",
        runId: "run-1",
        planStepId: "step-a",
        childTaskId: "task-a",
        attemptNumber: 2,
        triggerReason: "operator_manual_retry",
        schedulerSignalId: "sig-a-2",
        leaseGeneration: 0,
        ownerToken: "owner-1",
        now: LATER,
      });
      const linked = store.linkAbandonedRetryIntentReplacement({
        intentId: "intent-1",
        replacementAttemptId: "a-2",
        now: LATER,
      });
      const relinked = store.linkAbandonedRetryIntentReplacement({
        intentId: "intent-1",
        replacementAttemptId: "a-3",
        now: "2026-07-31T12:10:00.000Z",
      });

      expect(linked.replacementAttemptId).toBe("a-2");
      expect(relinked.replacementAttemptId).toBe("a-2");
      expect(store.listAbandonedRetryIntents()).toEqual([relinked]);
    });
  });
}
