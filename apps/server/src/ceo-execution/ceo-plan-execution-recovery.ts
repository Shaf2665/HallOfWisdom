import { CEO_PLAN_STEP_ATTEMPT_TERMINAL_STATUSES } from "@hall-of-wisdom/protocol";
import type { CeoPlanStorePort } from "../ceo-plans/ceo-plan-store-port.js";
import type { PreviousShutdownKind } from "../recovery/restart-recovery.js";
import type { CeoPlanRunStorePort } from "./ceo-plan-run-store-port.js";
import type { ExecutionSignalStorePort } from "./execution-signal-store-port.js";
import type { CeoPlanExecutionScheduler } from "./ceo-plan-execution-scheduler.js";

const RECOVERY_ACTOR = "recovery:hall-core" as const;

export interface CeoPlanExecutionRecoveryInput {
  readonly planRunStore: CeoPlanRunStorePort;
  readonly signalStore: ExecutionSignalStorePort;
  readonly scheduler: CeoPlanExecutionScheduler;
  readonly planStore: CeoPlanStorePort;
  readonly postBoardAudit: (planId: string, text: string) => void;
  readonly previousShutdown: PreviousShutdownKind;
  readonly now: string;
  /** Same `planRunStore` + `signalStore` atomic-unit seam the scheduler itself uses (see `SchedulerDeps.runAtomicUnit`) — wraps each unclean-restart run's synchronous attempt-abandon + signal-cancel + pause + event sequence so a mid-sequence throw leaves no partial state. */
  readonly runAtomicUnit: <T>(fn: () => T) => T;
}

export interface CeoPlanExecutionRecoverySummary {
  readonly runsScanned: number;
  readonly runsPausedForUncleanRestart: number;
  readonly attemptsAbandoned: number;
  readonly runsContinuedAfterCleanRestart: number;
  readonly runsSkippedMissingPlan: number;
}

/**
 * Phase 15's own restart-recovery pass — called once, by composition,
 * strictly AFTER `runRestartRecovery` (Phase 13) has returned. Ordering is
 * the entire safety property here: `runRestartRecovery` calls
 * `reconcileTasks`, which mutates `taskStore` directly through the
 * mutation-hook-wrapped store; `createMockAgentServerComposition`
 * deliberately holds `activateAutonomousScheduling()` back until AFTER
 * this function has run (see that composition's own doc comment), so no
 * previously-configured autonomous run's scheduler bridge can react to
 * anything `reconcileTasks` does while this function is still deciding
 * what to do with each run. This function is the ONLY thing allowed to
 * call `scheduler.enqueueSignal` before the bridge is armed.
 *
 * Unclean restart: every run still "running" is paused for intervention —
 * "no automatic retry of interrupted provider runs," and "never trust PID
 * liveness or a periodic heartbeat as a durable execution fence" (kickoff,
 * "Restart policy"). Every attempt not already terminal is marked
 * `abandoned` (never `failed` — it may genuinely have completed
 * out-of-band; `abandoned` says only "this process can no longer vouch for
 * it," not "it failed"), pending signals for the run are cancelled, and
 * exactly one bounded `ceo.execution.recovery_paused` event plus one
 * dedup-gated Board summary is appended — safe to call again on a repeat
 * unclean restart (the run is no longer "running" the second time, so the
 * loop below simply skips it).
 *
 * Clean restart: a "running" run's own attempts were already reconciled by
 * `reconcileTasks` at the task level (any task genuinely still non-terminal
 * with a run in progress is marked `failed` there, regardless of shutdown
 * cleanliness — see that function's doc comment); this function's own job
 * is narrower — rebuild the dependency index (a derived projection, never
 * persisted) for the run's exact approved plan version, then enqueue one
 * `startup_reconciliation` signal so the scheduler revalidates every step
 * fresh against current persisted state before starting anything new.
 */
export async function runCeoPlanExecutionRecovery(
  input: CeoPlanExecutionRecoveryInput,
): Promise<CeoPlanExecutionRecoverySummary> {
  const runningRuns = input.planRunStore.listRuns().filter((run) => run.status === "running");
  let runsPausedForUncleanRestart = 0;
  let attemptsAbandoned = 0;
  let runsContinuedAfterCleanRestart = 0;
  let runsSkippedMissingPlan = 0;

  for (const run of runningRuns) {
    if (input.previousShutdown === "unclean") {
      // Returned from inside the atomic span (rather than closed over via
      // an outer `let`) so the values are only ever observed once the
      // whole synchronous span has actually committed — never read a
      // stale/partial value if `runAtomicUnit` were to change how or
      // when it invokes `fn` in the future.
      const { abandoned, shouldPostAudit } = input.runAtomicUnit(() => {
        let abandonedCount = 0;
        const attempts = input.planRunStore.listAttempts(run.id);
        for (const attempt of attempts) {
          if (!CEO_PLAN_STEP_ATTEMPT_TERMINAL_STATUSES.includes(attempt.status)) {
            input.planRunStore.updateAttempt({
              attemptId: attempt.id,
              status: "abandoned",
              now: input.now,
            });
            abandonedCount += 1;
          }
        }
        // Symmetric with the attempt loop above: a step execution left
        // "claimed"/"starting"/"running" is otherwise permanently
        // excluded from ever being reconsidered again —
        // `#tryAdvanceStep`'s own terminal-status guard treats those
        // three statuses as "already active" and returns immediately,
        // for the lifetime of the process, even after an explicit
        // operator resume. Abandoning the attempt alone is not enough;
        // the step projection itself must move to a re-evaluatable
        // status too.
        for (const step of input.planRunStore.listStepExecutions(run.id)) {
          if (["claimed", "starting", "running"].includes(step.status)) {
            input.planRunStore.upsertStepExecution({
              runId: run.id,
              planStepId: step.planStepId,
              status: "awaiting_intervention",
              readinessReason: "operator_intervention",
              dependencySummary: step.dependencySummary,
            });
          }
        }
        input.signalStore.cancelSignalsForRun(run.id, input.now);
        input.planRunStore.recoveryPauseRun({
          runId: run.id,
          now: input.now,
          classification: "unclean_paused",
        });
        input.planRunStore.appendEvent({
          runId: run.id,
          type: "ceo.execution.recovery_paused",
          actor: RECOVERY_ACTOR,
          payload: { previousShutdown: "unclean" },
          now: input.now,
        });
        // Keyed by generation (not just "recovery_paused") so a second,
        // later unclean restart — after an operator resumed the run in
        // between, bumping `activeGeneration` — still posts its own
        // summary instead of being silently suppressed as a duplicate of
        // the first incident.
        const shouldPost = input.planRunStore.claimBoardAuditOnce(
          run.id,
          `recovery_paused_gen${String(run.activeGeneration)}`,
          input.now,
        );
        return { abandoned: abandonedCount, shouldPostAudit: shouldPost };
      });
      attemptsAbandoned += abandoned;
      if (shouldPostAudit) {
        input.postBoardAudit(
          run.planId,
          "Autonomous execution was paused for review after an unclean Hall Core restart. No interrupted work was automatically retried.",
        );
      }
      runsPausedForUncleanRestart += 1;
      continue;
    }

    // Clean restart (or first_start, though no run can already be
    // "running" on a genuine first start).
    let version;
    try {
      version = input.planStore.getVersion(run.planId, run.planVersion);
    } catch {
      // The plan's exact approved version is no longer resolvable — leave
      // the run as-is; the next real signal will fail closed the same way
      // a live mid-run lookup failure already does, rather than this
      // recovery pass guessing at stale step data.
      runsSkippedMissingPlan += 1;
      continue;
    }
    input.scheduler.registerDependencyIndex(
      run.id,
      version.steps.map((step) => ({ id: step.id, dependencies: step.dependencies })),
    );
    await input.scheduler.enqueueSignal({
      planRunId: run.id,
      reason: "startup_reconciliation",
    });
    runsContinuedAfterCleanRestart += 1;
  }

  return {
    runsScanned: runningRuns.length,
    runsPausedForUncleanRestart,
    attemptsAbandoned,
    runsContinuedAfterCleanRestart,
    runsSkippedMissingPlan,
  };
}
