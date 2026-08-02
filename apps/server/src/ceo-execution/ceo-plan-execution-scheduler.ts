import { randomUUID } from "node:crypto";
import type {
  CeoPlanExecutionCircuitTripReason,
  CeoPlanExecutionTriggerReason,
  CeoPlanRun,
  CeoPlanStepAttempt,
  CeoPlanStepExecution,
} from "@hall-of-wisdom/protocol";
import { CEO_PLAN_RUN_TERMINAL_STATUSES } from "@hall-of-wisdom/protocol";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { TaskRecord } from "../tasks/task-record.js";
import type { TaskOrchestrator } from "../tasks/task-orchestrator.js";
import { isTerminalTaskStatus } from "../tasks/task-status-transitions.js";
import {
  AdapterRequirementsMismatchError,
  AdapterUnavailableError,
  CeoPlanExecutionAbandonedRetryNotEligibleError,
  CeoPlanRunStateConflictError,
  CeoPlanStepAttemptConflictError,
  TaskStateConflictError,
} from "../errors/app-error.js";
import type { CeoPlanRunStorePort } from "./ceo-plan-run-store-port.js";
import type { ClaimedSignal, ExecutionSignalStorePort } from "./execution-signal-store-port.js";
import {
  buildDependencyIndex,
  directDependentsOf,
  evaluateDependencyReadiness,
  type DependencyIndex,
} from "./ceo-plan-step-readiness.js";
import { classifyExecutionFailure, decideRetry } from "./ceo-plan-execution-retries.js";
import { RESTART_INTERRUPTED_RUN_CODE } from "../recovery/reconcile-tasks.js";
import {
  computeProgressFingerprint,
  evaluateCircuitBreaker,
} from "./ceo-plan-execution-circuit-breaker.js";
import type { PlanRunEventBus } from "./plan-run-event-bus.js";

const SCHEDULER_ACTOR = "system:ceo-scheduler" as const;
const DEFAULT_ADAPTER_CAPACITY = 1;
/** Safety cap on how many signals one `enqueueSignal` call will drain synchronously — prevents an unbounded loop if a bug ever produced runaway self-requeuing. */
const MAX_DRAIN_ITERATIONS = 50;

export interface SchedulerDeps {
  readonly planRunStore: CeoPlanRunStorePort;
  readonly signalStore: ExecutionSignalStorePort;
  readonly taskStore: TaskStorePort;
  readonly taskOrchestrator: TaskOrchestrator;
  readonly now: () => string;
  readonly ownerToken: string;
  readonly leaseSeconds?: number;
  /** Dedup-gated Board summary — the scheduler always checks `planRunStore.claimBoardAuditOnce` first; this is only invoked when that returns `true`. */
  readonly postBoardAudit: (planId: string, text: string) => void;
  /**
   * The same seam `CeoPlanOrchestrator` already uses: `(fn) =>
   * withTransaction(db, fn)` in durable mode, or an ephemeral
   * snapshot/restore coordinator (`createEphemeralAtomicUnit`) in-memory.
   * Used only to wrap SYNCHRONOUS multi-write spans across
   * `planRunStore` + `signalStore` (never spans an `await` — an open
   * durable transaction cannot safely straddle one) — see
   * `#pauseForIntervention`, `emergencyStop`, and the two branches of
   * `onChildTaskMutated`.
   */
  readonly runAtomicUnit: <T>(fn: () => T) => T;
  /**
   * Optional so existing/synthetic-harness callers that don't care about
   * WebSocket fan-out don't need to supply one. `#appendEvent` is
   * structurally guaranteed to never be called from inside a still-open
   * `runAtomicUnit` span (see that private method's own doc comment), so
   * publishing immediately, right after the durable/ephemeral write
   * commits, is always safe — never before commit, never on a rolled-back
   * write.
   */
  readonly eventBus?: PlanRunEventBus | undefined;
  /**
   * Phase 15.3 — injection seam for the retry-due wake timer, defaulting
   * to real `setTimeout`/`clearTimeout`. Tests supply a fake clock/timer
   * pair (e.g. driven by an injected `now`) so the wake mechanism can be
   * asserted deterministically without a real wall-clock wait.
   */
  readonly scheduleWake?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  readonly cancelWake?: ((handle: unknown) => void) | undefined;
}

export interface EmergencyStopOutcome {
  readonly planStepId: string;
  readonly childTaskId: string;
  readonly outcome: "cancellation_requested" | "already_requested" | "failed";
  /** Present only when `outcome === "failed"` — a bounded, safe message (see `safeMessage`), never a raw error/path. */
  readonly detail?: string;
}

export interface EmergencyStopResult {
  readonly runId: string;
  readonly outcomes: readonly EmergencyStopOutcome[];
  /** `false` if even one linked active task's `outcome` is `"failed"` — never treat a partial cancellation as overall success. */
  readonly allSucceeded: boolean;
}

export interface EnqueueSignalInput {
  readonly planRunId: string;
  readonly planStepId?: string | undefined;
  readonly reason: CeoPlanExecutionTriggerReason;
  readonly priority?: "normal" | "high";
  readonly delaySeconds?: number;
}

function isTaskActive(status: string, hasRunId: boolean): boolean {
  return status === "running" || (status === "assigned" && hasRunId);
}

/**
 * Event-first, incremental scheduler for autonomous CEO plan execution.
 * Never scans every plan on every event — `enqueueSignal` targets exactly
 * one run (and, once claimed, `#processSignal` targets exactly the steps
 * that signal's reasons imply, via the dependency index's O(1) dependent
 * lookup), and idle periods do no work at all: no fixed-interval poll
 * loop, and the one timer that does exist (`#rearmWakeTimer`, Phase
 * 15.3's retry-due wake mechanism) is a single, precisely-targeted
 * one-shot for the soonest-due pending signal across every run — never
 * armed at all while nothing is pending (see
 * `docs/architecture/0015-...md`, "Event-first scheduler" and "Retry-due
 * wake mechanism"). A low-frequency, bounded reconciliation pass
 * (`reconcile()`) exists separately as a safety net — see
 * `ceo-plan-execution-recovery.ts` — and
 * is never the primary path here.
 *
 * Never calls an adapter directly and never bypasses `TaskOrchestrator` —
 * the one call this class ever makes into task execution is
 * `taskOrchestrator.startTask(childTaskId)`, exactly the same path a
 * human clicking "Start task" already uses.
 */
export class CeoPlanExecutionScheduler {
  readonly #planRunStore: CeoPlanRunStorePort;
  readonly #signalStore: ExecutionSignalStorePort;
  readonly #taskStore: TaskStorePort;
  readonly #taskOrchestrator: TaskOrchestrator;
  readonly #now: () => string;
  readonly #ownerToken: string;
  readonly #leaseSeconds: number;
  readonly #postBoardAudit: (planId: string, text: string) => void;
  readonly #runAtomicUnit: <T>(fn: () => T) => T;
  readonly #eventBus: PlanRunEventBus | undefined;
  readonly #dependencyIndexes = new Map<string, DependencyIndex>();
  readonly #progressFingerprints = new Map<string, string>();
  /**
   * Cross-run adapter-capacity wakeup index: `adapterId -> runId ->
   * stepIds` currently parked with `readinessReason ===
   * "waiting_for_capacity"` for that adapter. Populated only at the one
   * place a step is actually parked for capacity (inside
   * `#tryAdvanceStep`), cleared at the top of every re-evaluation of that
   * same step. Without this, a step blocked on a shared adapter's
   * capacity was only ever reconsidered by a later signal for its OWN
   * run — nothing woke it when a DIFFERENT run's task on the same
   * adapter freed a slot, which could starve it indefinitely if that
   * other run never produced another signal. See
   * `docs/architecture/0015-...md`, "Known Phase-15 limitations" (now
   * removed from that list — this closes the gap) and kickoff §10E
   * ("no starvation"). Deliberately keyed by adapter, not global, so a
   * completion never wakes runs that were never waiting on it.
   */
  readonly #capacityWaiters = new Map<string, Map<string, Set<string>>>();
  /** Reverse index for O(1) clearing: `${runId} ${stepId}` -> adapterId it was last recorded waiting on. */
  readonly #capacityWaitAdapter = new Map<string, string>();
  readonly #scheduleWake: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelWake: (handle: unknown) => void;
  /** Handle for the single currently-armed retry-due wake timer, or `undefined` if none is armed (idle — no pending signal anywhere). */
  #wakeTimerHandle: unknown;
  /** The `availableAt` the currently-armed timer targets — lets `#rearmWakeTimer` skip redundant re-arming when nothing earlier has appeared. */
  #wakeTimerTarget: string | undefined;

  constructor(deps: SchedulerDeps) {
    this.#planRunStore = deps.planRunStore;
    this.#signalStore = deps.signalStore;
    this.#taskStore = deps.taskStore;
    this.#taskOrchestrator = deps.taskOrchestrator;
    this.#now = deps.now;
    this.#ownerToken = deps.ownerToken;
    this.#leaseSeconds = deps.leaseSeconds ?? 30;
    this.#postBoardAudit = deps.postBoardAudit;
    this.#runAtomicUnit = deps.runAtomicUnit;
    this.#eventBus = deps.eventBus;
    this.#scheduleWake =
      deps.scheduleWake ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancelWake =
      deps.cancelWake ??
      ((handle) => {
        clearTimeout(handle as NodeJS.Timeout);
      });
  }

  /**
   * Phase 15.3 — arms the single retry-due wake timer, or (re)creates it
   * after a clean composition startup. Idempotent and cheap to call
   * whenever the caller isn't sure whether a timer is already armed
   * correctly (`#rearmWakeTimer` itself only replaces an existing timer
   * when a strictly earlier signal is now the soonest-due one).
   */
  start(): void {
    this.#rearmWakeTimer();
  }

  /** Cancels the armed wake timer, if any — called on composition shutdown so the process can exit cleanly instead of being held open by a pending `setTimeout`. */
  stop(): void {
    if (this.#wakeTimerHandle !== undefined) {
      this.#cancelWake(this.#wakeTimerHandle);
      this.#wakeTimerHandle = undefined;
      this.#wakeTimerTarget = undefined;
    }
  }

  /**
   * The retry-due wake mechanism: one timer for the single soonest-due
   * pending signal across every run (never one per task, never a
   * fixed-interval poll). Re-arms strictly earlier when a new signal with
   * an earlier `availableAt` is inserted (`#enqueueSignalSync` calls this
   * after every insert); cancels itself back to idle (no timer at all —
   * no busy loop) once nothing is pending. When the timer fires it drains
   * exactly like any other trigger — `#processSignal`'s own run-status/
   * generation checks are what keep a paused/cancelled/obsolete-generation
   * run from launching anything, not this timer.
   */
  #rearmWakeTimer(): void {
    const next = this.#signalStore.nextPendingAvailableAt();
    if (next === undefined) {
      this.stop();
      return;
    }
    if (this.#wakeTimerTarget !== undefined && this.#wakeTimerTarget <= next) {
      return;
    }
    if (this.#wakeTimerHandle !== undefined) {
      this.#cancelWake(this.#wakeTimerHandle);
    }
    const delayMs = Math.max(0, new Date(next).getTime() - new Date(this.#now()).getTime());
    this.#wakeTimerTarget = next;
    this.#wakeTimerHandle = this.#scheduleWake(() => {
      this.#wakeTimerHandle = undefined;
      this.#wakeTimerTarget = undefined;
      this.#drain()
        .catch(() => {
          // Best-effort — a missed wake is recoverable by the next
          // genuine signal for the run, or the bounded reconciliation
          // pass. Never lets a wake-timer failure crash the process.
        })
        .finally(() => {
          try {
            this.#rearmWakeTimer();
          } catch {
            // The store (e.g. a durable connection) may have been closed
            // between this timer firing and now — a shutdown that didn't
            // call `stop()` first (test harnesses closing a db directly,
            // an involuntary process exit). Never lets that surface as an
            // unhandled rejection; `stop()` is still the correct way to
            // cancel this deliberately.
          }
        });
    }, delayMs);
  }

  /** Called once by composition whenever a run is configured/resumed/recovered — builds the O(step-count) index for that run's immutable plan version. Never rebuilt per signal. */
  registerDependencyIndex(
    planRunId: string,
    steps: readonly { readonly id: string; readonly dependencies: readonly string[] }[],
  ): void {
    this.#dependencyIndexes.set(planRunId, buildDependencyIndex(steps));
  }

  forgetDependencyIndex(planRunId: string): void {
    this.#dependencyIndexes.delete(planRunId);
    for (const key of Array.from(this.#progressFingerprints.keys())) {
      if (key.startsWith(`${planRunId} `)) this.#progressFingerprints.delete(key);
    }
    for (const key of Array.from(this.#capacityWaitAdapter.keys())) {
      if (key.startsWith(`${planRunId} `)) {
        const stepId = key.slice(planRunId.length + 1);
        this.#clearCapacityWait(planRunId, stepId);
      }
    }
  }

  /** Records that `stepId` is now parked waiting for capacity on `adapterId`. Bounded by the number of distinct adapters × concurrently capacity-blocked steps — never proportional to total plan/step count. */
  #recordCapacityWait(adapterId: string, runId: string, stepId: string): void {
    this.#clearCapacityWait(runId, stepId);
    this.#capacityWaitAdapter.set(`${runId} ${stepId}`, adapterId);
    let byRun = this.#capacityWaiters.get(adapterId);
    if (!byRun) {
      byRun = new Map();
      this.#capacityWaiters.set(adapterId, byRun);
    }
    let steps = byRun.get(runId);
    if (!steps) {
      steps = new Set();
      byRun.set(runId, steps);
    }
    steps.add(stepId);
  }

  /** No-op if the step wasn't recorded as a capacity waiter — safe to call unconditionally at the top of every re-evaluation of a step. */
  #clearCapacityWait(runId: string, stepId: string): void {
    const key = `${runId} ${stepId}`;
    const adapterId = this.#capacityWaitAdapter.get(key);
    if (adapterId === undefined) return;
    this.#capacityWaitAdapter.delete(key);
    const byRun = this.#capacityWaiters.get(adapterId);
    const steps = byRun?.get(runId);
    steps?.delete(stepId);
    if (steps?.size === 0) byRun?.delete(runId);
    if (byRun?.size === 0) this.#capacityWaiters.delete(adapterId);
  }

  /**
   * Wakes every OTHER run's steps currently parked waiting for capacity
   * on `adapterId` — called once a task on that adapter reaches a
   * terminal state and genuinely frees a slot. A pure index lookup: does
   * nothing at all (zero extra step reads, zero extra signals) unless
   * some other run is actually waiting on this exact adapter, so it adds
   * no cost to the common case the efficiency tests (kickoff §10A)
   * measure. Targets the specific waiting steps directly (not a
   * plan-level signal), so only those steps are re-evaluated — never the
   * whole run.
   */
  async #wakeCapacityWaiters(adapterId: string, excludeRunId: string): Promise<void> {
    const byRun = this.#capacityWaiters.get(adapterId);
    if (!byRun) return;
    for (const [runId, steps] of Array.from(byRun.entries())) {
      if (runId === excludeRunId || steps.size === 0) continue;
      for (const stepId of Array.from(steps)) {
        await this.enqueueSignal({
          planRunId: runId,
          planStepId: stepId,
          reason: "adapter_availability_changed",
        });
      }
    }
  }

  /** Event-first entry point. Enqueues (or coalesces into) a durable signal, then immediately drains claimable work — no polling interval needed for the common case. */
  async enqueueSignal(input: EnqueueSignalInput): Promise<void> {
    this.#enqueueSignalSync(input);
    await this.#drain();
  }

  /**
   * The synchronous half of `enqueueSignal` — just the signal-store
   * write, with no `await` anywhere in it. Callers that need this
   * enqueue to roll back together with a preceding `planRunStore` write
   * (e.g. `onChildTaskMutated` marking a step "completed" and enqueueing
   * the signal that notifies its dependents) call this directly from
   * inside `#runAtomicUnit`, then call `#drain()` afterward, outside the
   * atomic span — draining does real async work (possibly starting a
   * task), which must never happen while a durable transaction is still
   * open.
   */
  #enqueueSignalSync(input: EnqueueSignalInput): void {
    const now = this.#now();
    const run = this.#planRunStore.findRun(input.planRunId);
    if (run?.status !== "running") return;
    const delaySeconds = input.delaySeconds ?? 0;
    const availableAt =
      delaySeconds > 0
        ? new Date(new Date(now).getTime() + delaySeconds * 1000).toISOString()
        : now;
    this.#signalStore.enqueue({
      signalId: randomUUID(),
      planRunId: input.planRunId,
      planStepId: input.planStepId,
      generation: run.activeGeneration,
      reason: input.reason,
      priority: input.priority ?? "normal",
      availableAt,
      now,
    });
    // Phase 15.3 — every insert, delayed or not, is a chance the new
    // soonest-due signal is earlier than whatever the wake timer already
    // targets. A same-or-later insert is a cheap no-op inside
    // `#rearmWakeTimer` (single comparison, no timer churn); an
    // immediately-available (`delaySeconds` 0) signal here is about to be
    // claimed by this same call's own `#drain()` anyway, so arming for it
    // is harmless even though redundant.
    this.#rearmWakeTimer();
  }

  async #drain(): Promise<void> {
    for (let i = 0; i < MAX_DRAIN_ITERATIONS; i += 1) {
      const processed = await this.tick();
      if (!processed) return;
    }
  }

  /** Claims and processes at most one signal. Returns `true` if a signal was claimed (whether or not it led to a launch), `false` if there was nothing claimable. */
  async tick(): Promise<boolean> {
    const now = this.#now();
    // Manual-mode runs are never claimed here — "Manual: Scheduler never
    // starts a child task" (kickoff, "Execution modes"). A manual-mode
    // run may exist purely for tracking/display; this is the one place
    // that boundary is enforced, not merely assumed by callers.
    const activeRunIds = this.#planRunStore
      .listRuns()
      .filter((r) => r.status === "running" && r.executionMode === "autonomous")
      .map((r) => r.id);
    if (activeRunIds.length === 0) return false;
    const claimed = this.#signalStore.claimNext({
      now,
      ownerToken: this.#ownerToken,
      leaseSeconds: this.#leaseSeconds,
      eligibleRunIds: activeRunIds,
    });
    if (!claimed) return false;
    await this.#processSignal(claimed);
    return true;
  }

  async #processSignal(claimed: ClaimedSignal): Promise<void> {
    const { signal } = claimed;
    const run = this.#planRunStore.findRun(signal.planRunId);
    if (run?.status !== "running" || run.activeGeneration !== signal.generation) {
      // Stale — the run moved on since this signal was queued (paused,
      // resumed to a new generation, cancelled, or recovery-paused).
      this.#signalStore.releaseClaim(signal.id, claimed.claimLease, this.#now());
      return;
    }
    const index = this.#dependencyIndexes.get(run.id);
    if (!index) {
      this.#signalStore.releaseClaim(signal.id, claimed.claimLease, this.#now());
      return;
    }

    const targetStepIds = this.#resolveTargetSteps(index, signal.planStepId, signal.reasons);
    for (const stepId of targetStepIds) {
      await this.#tryAdvanceStep(
        run,
        stepId,
        index,
        signal.reasons[0] ?? "startup_reconciliation",
        signal.id,
      );
    }

    this.#maybeCompleteRun(run.id);
    this.#signalStore.markProcessed(signal.id, claimed.claimLease, this.#now());
    this.#planRunStore.recordSchedulerDecision(run.id, this.#now());
  }

  #resolveTargetSteps(
    index: DependencyIndex,
    planStepId: string | undefined,
    reasons: readonly CeoPlanExecutionTriggerReason[],
  ): readonly string[] {
    if (planStepId === undefined) {
      // Plan-level signal (execution_started, capacity_available,
      // operator_resumed, startup/periodic_reconciliation) — reconsider
      // every step of THIS run only, never another plan's.
      return index.allStepIds;
    }
    const reconsiderSelf = reasons.some((r) =>
      ["retry_due", "operator_manual_retry", "adapter_availability_changed"].includes(r),
    );
    const reconsiderDependents = reasons.some((r) =>
      ["task_terminal", "dependency_completed", "dependency_failed"].includes(r),
    );
    const targets = new Set<string>();
    if (reconsiderSelf) targets.add(planStepId);
    if (reconsiderDependents)
      for (const dependent of directDependentsOf(index, planStepId)) targets.add(dependent);
    if (targets.size === 0) targets.add(planStepId);
    // Deterministic order matching the plan's own declared step order.
    return index.allStepIds.filter((id) => targets.has(id));
  }

  #countRunningSteps(runId: string): number {
    return this.#planRunStore
      .listStepExecutions(runId)
      .filter((s) => ["claimed", "starting", "running"].includes(s.status)).length;
  }

  #adapterCapacity(run: CeoPlanRun, adapterId: string): number {
    return run.policySnapshot.adapterConcurrencyOverrides?.[adapterId] ?? DEFAULT_ADAPTER_CAPACITY;
  }

  #countActiveForAdapter(adapterId: string): number {
    return this.#taskStore
      .list()
      .filter(
        (r) => r.adapterId === adapterId && isTaskActive(r.task.status, r.runId !== undefined),
      ).length;
  }

  /**
   * Phase 15.2 — closes the retry deadlock (see
   * `docs/architecture/0015-autonomous-plan-execution-and-scheduling.md`,
   * "Retry deadlock root cause"): a step legitimately parked
   * `"retry_wait"` (an earlier real task failure was classified
   * `"transient"` and `decideRetry` scheduled a backoff) could never
   * actually launch attempt 2, because the underlying child task itself
   * stayed `"failed"` — a genuinely terminal status nothing ever
   * reversed. Called from `#tryAdvanceStep` immediately before its
   * `taskRecord.task.status !== "assigned"` guard, ONLY when that guard
   * would otherwise reject a `"retry_wait"` step whose backoff has
   * already elapsed (the caller already checked `nextEligibleAt`).
   *
   * Verifies every precondition below that `TaskOrchestrator.
   * startTask()` itself cannot check (it has no notion of plan runs,
   * attempts, circuits, or retry policy). Deliberately does NOT
   * re-verify current launch eligibility (capability/execution-trust/
   * requirements/adapter availability) — that stays `startTask()`'s own
   * authoritative job, run fresh immediately after this returns via the
   * exact same guard every other launch goes through. Duplicating it
   * here would add an extra `await` gap between two atomic commits,
   * reopening exactly the kind of race Section 1 closed.
   *
   * Fully synchronous — no `await` anywhere in this method — so nothing
   * checked here can go stale before `TaskOrchestrator.prepareRetry()`'s
   * own atomic commit runs.
   *
   * Returns the reset `TaskRecord` on success, or `undefined` if any
   * precondition fails or a competing preparation already won — the
   * caller falls through to its normal guard in either case, which will
   * correctly reject and leave the step exactly where a legitimate
   * rejection should.
   */
  #prepareTaskRetryIfEligible(
    run: CeoPlanRun,
    step: CeoPlanStepExecution,
    taskRecord: TaskRecord,
  ): TaskRecord | undefined {
    // 1. Task linked to exact run/step.
    if (step.planRunId !== run.id || step.childTaskId !== taskRecord.task.taskId) {
      return undefined;
    }
    // 7 & 10. Run is running (not paused/cancelled/awaiting_intervention).
    if (run.status !== "running") return undefined;
    // 9. Circuit closed.
    if (this.#planRunStore.getCircuitState(run.id).state === "open") return undefined;
    // 5. Attempts below policy.
    if (step.attemptCount >= run.policySnapshot.maxAttemptsPerStep) return undefined;

    // 2 & 4. Previous attempt terminal, and its safe failure
    // classification permits retry — never cancelled, never security.
    const attempts = this.#planRunStore.listAttempts(run.id, step.planStepId);
    const latestAttempt = attempts[attempts.length - 1];
    if (latestAttempt?.status !== "failed") return undefined;
    if (
      latestAttempt.safeFailureCode === "cancelled" ||
      latestAttempt.safeFailureCode === "security"
    ) {
      return undefined;
    }

    // 3. Previous task run has exactly one terminal event — structurally
    // guaranteed for a "failed" task by EventStore's own reserved-
    // terminal-slot invariant; defensively re-verified here.
    if (taskRecord.task.status !== "failed" || taskRecord.terminalEventType === undefined) {
      return undefined;
    }
    // Never retry a task whose terminal failure was a restart
    // interruption — Phase 13's unclean-restart rule (interrupted
    // provider work is never automatically resumed or retried) stays
    // true for governed retry too, automatic or manual.
    if (taskRecord.failure?.code === RESTART_INTERRUPTED_RUN_CODE) return undefined;
    // 11. Approved assignment still matches — the task must still carry
    // the adapter it was actually assigned; never silently substituted.
    if (taskRecord.adapterId === undefined) return undefined;

    try {
      // 13. No competing retry preparation already succeeded — enforced
      // by TaskOrchestrator.prepareRetry()'s own revision-checked atomic
      // commit. Every check above ran with no `await` since, so nothing
      // here can itself be the source of a race; the commit is still the
      // authority, not this method's own read.
      return this.#taskOrchestrator.prepareRetry(taskRecord.task.taskId);
    } catch (error) {
      if (error instanceof TaskStateConflictError) return undefined;
      throw error;
    }
  }

  /**
   * Phase 15.6 — the ONLY path that can relaunch a step abandoned by
   * unclean-restart recovery (`ceo-plan-execution-recovery.ts`'s
   * unclean-restart branch, the sole place any `CeoPlanStepAttempt` ever
   * reaches `"abandoned"` — see that file's own doc comment). Reachable
   * exclusively from the explicit "Retry step" REST route
   * (`routes/ceo-plan-runs.ts`) — never from `tick()`/`#drain()`'s
   * automatic signal processing, and structurally distinct from
   * `#prepareTaskRetryIfEligible` above, which explicitly EXCLUDES any
   * task whose failure carries `RESTART_INTERRUPTED_RUN_CODE` (line ~558)
   * — "never retry a task whose terminal failure was a restart
   * interruption... automatic or manual" was true before this method
   * existed and stays true for every AUTOMATIC path; this method is the
   * one narrow, independently-gated, EXPLICIT-operator-only exception,
   * mirroring how `TaskStore.prepareRetryIfEligible()` itself is the one
   * narrow exception to `updateStatus()`'s general `failed -> assigned`
   * prohibition.
   *
   * Chosen lifecycle (see `docs/architecture/0015-...md`): an unclean
   * restart never automatically retries or resumes provider work — the
   * run pauses to `awaiting_intervention` and every non-terminal attempt
   * is abandoned. An operator must explicitly Resume first (moves the run
   * back to `"running"`, resets the circuit, re-registers the dependency
   * index — see `routes/ceo-plan-runs.ts`'s `/resume` handler), THEN
   * explicitly click "Retry step" on the specific abandoned step. Resume
   * alone starts nothing; this method is never called by `/resume`.
   *
   * Verifies, synchronously and with no `await` before the one atomic
   * commit, every precondition the kickoff's numbered list requires:
   * task/step/run linkage, run running, step genuinely
   * `awaiting_intervention`, the latest attempt genuinely `"abandoned"`
   * (never `"failed"` — that is `#prepareTaskRetryIfEligible`'s or the
   * circuit/retry machinery's job, never this method's), the task's
   * failure carries `RESTART_INTERRUPTED_RUN_CODE` specifically (proving
   * the abandonment really did come from unclean-restart recovery, not
   * some other terminal path), a committed terminal event exists, no
   * active task run, and the approved assignment is still present. The
   * dependency index must already exist for this run (rebuilt by
   * `/resume`, or already present if Resume happened earlier in the same
   * process) — this method never rebuilds it itself (the scheduler has no
   * `CeoPlanStorePort` dependency to resolve the approved plan version
   * from), so a missing index fails loudly here rather than silently
   * enqueueing a signal `#processSignal` would just drop.
   *
   * Deliberately does NOT check plan-cancelled directly: the scheduler has
   * no dependency on `CeoPlanStorePort`, and `run.status === "running"` is
   * sufficient — a cancelled plan's run cannot be `"running"` (plan
   * cancellation only ever follows from its parent task's own
   * cancellation, which reconciliation already reflects into run status).
   *
   * On success: calls `TaskOrchestrator.prepareRetry()` (the same atomic,
   * revision-CAS commit `#prepareTaskRetryIfEligible` already uses —
   * "no competing recovery has already succeeded" is enforced by THIS
   * commit, not by any read above it), appends exactly one
   * `ceo.execution.retry_requested` event attributed to
   * `"human:local-operator"` (never the scheduler's own
   * `system:ceo-scheduler` actor — this action was explicitly requested by
   * a person, and the audit trail should say so), then hands off to the
   * ordinary `enqueueSignal({reason: "operator_manual_retry"})` path —
   * the task record is now genuinely `"assigned"`, so `#tryAdvanceStep`'s
   * normal claim-then-`TaskOrchestrator.startTask()` tail runs exactly as
   * it would for any other step, re-running current adapter detection,
   * capability/execution-trust eligibility, and the revision/assignment
   * CAS, and creating exactly one new attempt with exactly one new
   * task-run ID. Never bypasses `startTask()`; never duplicates its
   * claim/launch logic.
   *
   * Throws `CeoPlanExecutionAbandonedRetryNotEligibleError` (409, a
   * bounded safe reason, never raw error text) for every rejection case —
   * a loud, explicit rejection, never a silent no-op, since this is
   * always an explicit operator request.
   */
  async retryAbandonedStep(runId: string, planStepId: string): Promise<void> {
    const run = this.#planRunStore.getRun(runId);
    const step = this.#planRunStore.getStepExecution(runId, planStepId);
    if (step.planRunId !== run.id) {
      throw new CeoPlanExecutionAbandonedRetryNotEligibleError(
        runId,
        planStepId,
        "step does not belong to this run",
      );
    }
    // 2. Run currently running — i.e. the operator already resumed it.
    if (run.status !== "running") {
      throw new CeoPlanExecutionAbandonedRetryNotEligibleError(
        runId,
        planStepId,
        "run is not running (resume the run first)",
      );
    }
    // 15. Step not completed/cancelled — must be exactly the status
    // unclean-restart recovery left it in.
    if (step.status !== "awaiting_intervention") {
      throw new CeoPlanExecutionAbandonedRetryNotEligibleError(
        runId,
        planStepId,
        "step is not awaiting intervention",
      );
    }

    let taskRecord: TaskRecord;
    try {
      taskRecord = this.#taskStore.get(step.childTaskId);
    } catch {
      throw new CeoPlanExecutionAbandonedRetryNotEligibleError(
        runId,
        planStepId,
        "linked task not found",
      );
    }

    // 6, 7, 11. The latest attempt exists and is genuinely "abandoned" —
    // the ONE status `ceo-plan-execution-recovery.ts`'s unclean-restart
    // branch ever sets, so this check alone already proves "resulted from
    // unclean-restart recovery" structurally; the failure-code check below
    // is a second, independent confirmation across the task/attempt
    // boundary, not redundant with this one.
    const attempts = this.#planRunStore.listAttempts(run.id, planStepId);
    const latestAttempt = attempts[attempts.length - 1];
    if (latestAttempt?.status !== "abandoned") {
      throw new CeoPlanExecutionAbandonedRetryNotEligibleError(
        runId,
        planStepId,
        "latest attempt is not abandoned",
      );
    }
    // 8, 9. The task's own terminal failure carries the bounded
    // restart-interrupted code — confirms this specific task really was
    // interrupted by an unclean restart, never an ordinary permanent
    // failure or a security/cancelled outcome routed here by mistake.
    if (
      taskRecord.task.status !== "failed" ||
      taskRecord.failure?.code !== RESTART_INTERRUPTED_RUN_CODE
    ) {
      throw new CeoPlanExecutionAbandonedRetryNotEligibleError(
        runId,
        planStepId,
        "task was not interrupted by an unclean restart",
      );
    }
    // Attempts below policy — the SAME `maxAttemptsPerStep` budget
    // `#prepareTaskRetryIfEligible` already enforces for the `retry_wait`
    // case (its own numbered check 5); the abandoned attempt counts
    // toward it exactly like any other attempt would, by design — a
    // governed recovery is still bounded, never an unlimited escape
    // hatch. Checked explicitly HERE, not left to `#tryAdvanceStep`'s own
    // downstream `policy_limit_reached` guard: that guard fails silently
    // (the step is parked `awaiting_intervention` again, but this
    // method's caller — the explicit REST route — would see no error at
    // all, a false-success result for an operator who explicitly asked
    // for a retry).
    if (step.attemptCount >= run.policySnapshot.maxAttemptsPerStep) {
      throw new CeoPlanExecutionAbandonedRetryNotEligibleError(
        runId,
        planStepId,
        "attempt limit for this step has already been reached",
      );
    }
    // 10. Previous task run has a committed terminal event — same
    // defensive re-check `#prepareTaskRetryIfEligible` performs.
    if (taskRecord.terminalEventType === undefined) {
      throw new CeoPlanExecutionAbandonedRetryNotEligibleError(
        runId,
        planStepId,
        "no committed terminal event for the previous task run",
      );
    }
    // 12. No active task run — already guaranteed by the `"failed"` check
    // above: `TaskStore.setCompleted()` (called for every terminal
    // outcome, including the restart-interrupted path) never clears
    // `runId` — it is preserved as history of which run last executed
    // this task, exactly like `#prepareTaskRetryIfEligible` above already
    // relies on (it never checks `runId` either) — so a live `runId`
    // value here is normal and expected, never a sign of an active run. A
    // task whose `status` is genuinely `"failed"` cannot also have an
    // active run (`isTaskActive()`'s own definition: only `"running"`, or
    // `"assigned"` with a claimed `runId`, count as active).
    // 13. Approved assignment still present — never silently substituted;
    // current eligibility (capability/execution-trust/requirements) is
    // re-verified fresh by `startTask()` itself, not duplicated here.
    if (taskRecord.adapterId === undefined || taskRecord.agentId === undefined) {
      throw new CeoPlanExecutionAbandonedRetryNotEligibleError(
        runId,
        planStepId,
        "approved assignment is missing",
      );
    }
    // The dependency index must already exist — never rebuilt here (see
    // this method's own doc comment). A missing index means `/resume`
    // never ran in THIS process instance (or ran before this method
    // existed); failing loudly here is strictly better than enqueueing a
    // signal `#processSignal` would silently drop at its own `if (!index)`
    // guard.
    if (!this.#dependencyIndexes.has(run.id)) {
      throw new CeoPlanExecutionAbandonedRetryNotEligibleError(
        runId,
        planStepId,
        "no dependency index for this run (resume the run first)",
      );
    }

    try {
      // 16. No competing recovery has already succeeded — enforced by
      // this call's own revision-checked atomic commit, the true
      // authority; every check above ran with no `await` since, so
      // nothing above can itself be the source of a race.
      this.#taskOrchestrator.prepareRetry(taskRecord.task.taskId);
    } catch (error) {
      if (error instanceof TaskStateConflictError) {
        throw new CeoPlanExecutionAbandonedRetryNotEligibleError(
          runId,
          planStepId,
          "a competing recovery already succeeded",
        );
      }
      throw error;
    }

    // Attributed to the explicit operator, never `SCHEDULER_ACTOR` — every
    // other event this class emits is a mechanical consequence of a
    // signal; this one exists only because a person clicked "Retry step".
    const event = this.#planRunStore.appendEvent({
      runId: run.id,
      type: "ceo.execution.retry_requested",
      actor: "human:local-operator",
      payload: {
        planStepId,
        previousTaskRunId: latestAttempt.taskRunId ?? "",
      },
      now: this.#now(),
    });
    this.#eventBus?.publish(run.id, event);
    // Dedup-gated exactly like every other Board summary this class posts
    // (`#postAuditOnce`/`claimBoardAuditOnce`) — keyed by the SPECIFIC
    // abandoned attempt being recovered, so a genuinely duplicate or
    // concurrent "Retry step" request (only one of which can ever win the
    // `prepareRetry()` race above) can never post twice. Boards are
    // ephemeral/in-memory (see `docs/architecture/0007-...md`); this is a
    // best-effort operator notification, never the authoritative
    // cross-restart dedup source — that is the durable execution-event
    // log this method already writes to above.
    this.#postAuditOnce(
      run.planId,
      run.id,
      `abandoned_retry_${latestAttempt.id}`,
      "An operator explicitly retried a step that was abandoned by an unclean Hall Core restart. A new attempt has been prepared.",
    );

    // Hands off to the ordinary claim-then-launch path — see this
    // method's own doc comment for why no claim/launch logic is
    // duplicated here.
    await this.enqueueSignal({
      planRunId: run.id,
      planStepId,
      reason: "operator_manual_retry",
    });
  }

  async #tryAdvanceStep(
    run: CeoPlanRun,
    stepId: string,
    index: DependencyIndex,
    triggerReason: CeoPlanExecutionTriggerReason,
    signalId: string,
  ): Promise<void> {
    this.#clearCapacityWait(run.id, stepId);
    const step = this.#planRunStore.findRun(run.id)
      ? this.#planRunStore.getStepExecution(run.id, stepId)
      : undefined;
    if (!step) return;
    if (["completed", "cancelled", "claimed", "starting", "running"].includes(step.status)) return;
    // A `retry_wait` step is only reconsidered once its backoff has
    // actually elapsed — without this gate, any plan-level signal
    // (e.g. `/resume`, `startup_reconciliation`) would walk every
    // `retry_wait` step straight into a fresh attempt, bypassing
    // `policy.retryBackoffSeconds` entirely. Note this only *gates* an
    // early retry; nothing currently wakes a `retry_wait` step up on
    // its own once `nextEligibleAt` passes (see
    // `docs/architecture/0015-...md`, "Known Phase-15 limitations") —
    // it is reconsidered the next time some other signal for this run
    // happens to arrive.
    if (
      step.status === "retry_wait" &&
      step.nextEligibleAt !== undefined &&
      this.#now() < step.nextEligibleAt
    ) {
      return;
    }

    const dependencyStepIds = index.dependencies.get(stepId) ?? [];
    const readiness = evaluateDependencyReadiness(dependencyStepIds, (depId) => {
      try {
        return this.#planRunStore.getStepExecution(run.id, depId).status;
      } catch {
        return undefined;
      }
    });
    if (!readiness.ready) {
      this.#planRunStore.upsertStepExecution({
        runId: run.id,
        planStepId: stepId,
        status:
          readiness.reason === "waiting_for_dependencies"
            ? "waiting_for_dependencies"
            : "awaiting_intervention",
        readinessReason: readiness.reason,
        dependencySummary: readiness.summary,
      });
      if (
        (readiness.reason === "blocked_by_failed_dependency" ||
          readiness.reason === "blocked_by_cancelled_dependency") &&
        run.policySnapshot.pauseOnAnyPermanentFailure
      ) {
        this.#pauseForIntervention(run.id, "dependency-blocked");
      }
      return;
    }

    const circuit = this.#planRunStore.getCircuitState(run.id);
    if (circuit.state === "open") return;

    if (this.#countRunningSteps(run.id) >= run.policySnapshot.maxConcurrentSteps) {
      this.#planRunStore.upsertStepExecution({
        runId: run.id,
        planStepId: stepId,
        status: "ready",
        readinessReason: "waiting_for_capacity",
        dependencySummary: readiness.summary,
      });
      return;
    }

    let taskRecord;
    try {
      taskRecord = this.#taskStore.get(step.childTaskId);
    } catch {
      return;
    }

    // Retry-deadlock closure (Phase 15.2): a `"retry_wait"` step whose
    // backoff already elapsed (guaranteed by the gate above) is normally
    // unlaunchable forever, because its child task is still genuinely
    // `"failed"` — nothing else ever reverses that. Prepare it first; if
    // preparation succeeds, `taskRecord` is refreshed to the reset
    // `"assigned"` record and falls through to the exact same
    // claim-then-`startTask()` path a fresh step already uses. If
    // preparation is ineligible for any reason, `taskRecord` is left
    // untouched and the guard immediately below correctly rejects it.
    if (step.status === "retry_wait" && taskRecord.task.status === "failed") {
      const prepared = this.#prepareTaskRetryIfEligible(run, step, taskRecord);
      if (prepared !== undefined) taskRecord = prepared;
    }

    if (
      taskRecord.task.status !== "assigned" ||
      taskRecord.runId !== undefined ||
      isTerminalTaskStatus(taskRecord.task.status) ||
      taskRecord.adapterId === undefined
    ) {
      return;
    }
    if (
      this.#countActiveForAdapter(taskRecord.adapterId) >=
      this.#adapterCapacity(run, taskRecord.adapterId)
    ) {
      this.#planRunStore.upsertStepExecution({
        runId: run.id,
        planStepId: stepId,
        status: "ready",
        readinessReason: "waiting_for_capacity",
        dependencySummary: readiness.summary,
      });
      this.#recordCapacityWait(taskRecord.adapterId, run.id, stepId);
      return;
    }

    const attemptNumber = step.attemptCount + 1;
    if (attemptNumber > run.policySnapshot.maxAttemptsPerStep) {
      this.#planRunStore.upsertStepExecution({
        runId: run.id,
        planStepId: stepId,
        status: "awaiting_intervention",
        readinessReason: "policy_limit_reached",
        dependencySummary: readiness.summary,
      });
      if (run.policySnapshot.pauseOnAnyPermanentFailure)
        this.#pauseForIntervention(run.id, "attempt-limit");
      return;
    }

    const now = this.#now();
    const attemptId = randomUUID();
    let attempt: CeoPlanStepAttempt;
    try {
      // Wrapped in the same atomic-unit mechanism as every other
      // multi-write span here (see `SchedulerDeps.runAtomicUnit`'s doc
      // comment). `claimAttempt` internally performs two writes (create
      // the attempt row, then mark the step "claimed"); this wrapper is
      // what makes that span atomic in ephemeral mode — it snapshots
      // `planRunStore` before either write and restores it wholesale if
      // either one throws, so a failure between the two writes leaves NO
      // dangling attempt row and no orphaned step-execution update. See
      // `CeoPlanRunStorePort.claimAttempt`'s doc comment, and
      // `ceo-plan-execution-atomicity.contract.ts`'s "attempt creation"
      // test, which injects exactly that failure and proves both writes
      // roll back together — this is the "disclosed in-memory cross-store
      // atomicity gap" kickoff §8 asked to close, and it is closed.
      ({ attempt } = this.#runAtomicUnit(() =>
        this.#planRunStore.claimAttempt({
          attemptId,
          runId: run.id,
          planStepId: stepId,
          childTaskId: step.childTaskId,
          attemptNumber,
          triggerReason,
          schedulerSignalId: signalId,
          leaseGeneration: run.activeGeneration,
          ownerToken: this.#ownerToken,
          now,
          readinessReason: "ready",
          dependencySummary: readiness.summary,
        }),
      ));
    } catch (error) {
      if (error instanceof CeoPlanStepAttemptConflictError) return;
      throw error;
    }
    this.#appendEvent(run.id, "ceo.execution.step_claimed", { planStepId: stepId, attemptNumber });

    try {
      const started = await this.#taskOrchestrator.startTask(step.childTaskId);
      this.#planRunStore.updateAttempt({
        attemptId: attempt.id,
        status: "running",
        now: this.#now(),
        taskRunId: started.runId,
        startedAt: this.#now(),
      });
      this.#planRunStore.upsertStepExecution({
        runId: run.id,
        planStepId: stepId,
        status: "running",
        readinessReason: "ready",
        dependencySummary: readiness.summary,
        startedAt: this.#now(),
      });
      this.#appendEvent(run.id, "ceo.execution.step_started", {
        planStepId: stepId,
        attemptNumber,
      });
      // Deliberately NOT `recordCircuitProgress` here — a successful
      // launch is activity, not durable progress (see
      // `docs/architecture/0015-...md`, "Circuit progress is not launch
      // activity"). Resetting the failure streak the moment attempt N+1
      // starts is exactly the defect this session's kickoff describes:
      // it makes a repeated-failure threshold above 1 unreachable, because
      // every attempt's own launch erases the count the PREVIOUS attempt's
      // failure just added, before this new attempt has had any chance to
      // fail itself. The only place that legitimately resets the streak is
      // `onChildTaskMutated`'s `"completed"` branch, where the step has
      // actually finished — see that call site's own comment.
    } catch (error) {
      this.#handleStartFailure(run, stepId, attempt.id, attemptNumber, readiness.summary, error);
    }
  }

  #handleStartFailure(
    run: CeoPlanRun,
    stepId: string,
    attemptId: string,
    attemptNumber: number,
    dependencySummary: CeoPlanStepExecution["dependencySummary"],
    error: unknown,
  ): void {
    // Phase 15.2 — `TaskOrchestrator.startTask()`'s final launch-time
    // eligibility guard (capability/execution-trust/requirements no
    // longer eligible, or the assignment/revision/run-id drifted while
    // `detect()` was awaited) rejects with `AdapterRequirementsMismatchError`
    // (capability/trust/requirements no longer eligible) or
    // `TaskStateConflictError` (assignment/revision/run-id changed
    // underneath this attempt). Both are classified `requirements_changed`
    // — the scheduler's own preflight readiness check is only advisory;
    // this orchestrator-level rejection is authoritative, and
    // `requirements_changed` is (like every non-`transient` classification)
    // never automatically retried by `decideRetry` below, so eligibility
    // drift can never silently retry itself back into the same rejection.
    // This is intentionally a DIFFERENT bucket from the generic
    // `TASK_START_FAILED` structured failure below, which stays for
    // start failures with no more specific safe classification.
    const isLaunchEligibilityRejection =
      error instanceof AdapterRequirementsMismatchError || error instanceof TaskStateConflictError;
    const classification = isLaunchEligibilityRejection
      ? classifyExecutionFailure({ kind: "requirements_changed" })
      : error instanceof AdapterUnavailableError
        ? classifyExecutionFailure({ kind: "adapter_unavailable" })
        : classifyExecutionFailure({
            kind: "structured_failure",
            failure: { code: "TASK_START_FAILED", message: safeMessage(error), retryable: false },
          });
    const now = this.#now();
    if (isLaunchEligibilityRejection) {
      // Any other signal already coalesced/queued for this exact step is
      // now obsolete — the step is about to move to
      // `awaiting_intervention` off a never-auto-retry classification and
      // must not be silently relaunched by a stale duplicate trigger. Never
      // cancels the whole run's signals (other steps keep executing) —
      // that broader cancellation is `#pauseForIntervention`'s job, called
      // separately below only when the circuit trips or the policy
      // requires pausing on any permanent failure.
      this.#signalStore.cancelSignalsForStep(run.id, stepId, now);
    }
    this.#planRunStore.updateAttempt({
      attemptId,
      status: "failed",
      now,
      safeFailureCode: classification,
      safeFailureSummary: safeMessage(error),
      finishedAt: now,
    });
    this.#planRunStore.upsertStepExecution({
      runId: run.id,
      planStepId: stepId,
      status: "awaiting_intervention",
      readinessReason: "adapter_ineligible",
      dependencySummary,
      lastFailureCode: classification,
    });
    this.#appendEvent(run.id, "ceo.execution.step_failed", {
      planStepId: stepId,
      safeFailureCode: classification,
    });

    const isNoProgress = this.#recordFingerprintAndCheckProgress(run.id, stepId, {
      childTaskStatus: "assigned",
      lastEventSequence: undefined,
      hasTerminalResultEvidence: false,
      dependencyCompletedCount: dependencySummary.completedDependencies,
    });
    // Deliberate: a launch-eligibility rejection (`requirements_changed`)
    // counts toward the circuit exactly like any other start failure,
    // never a separate/softer bucket. Never-auto-retry only means "don't
    // relaunch THIS attempt" — it says nothing about whether the RUN as a
    // whole is healthy. A run that keeps producing eligibility-drift
    // rejections across different steps is exactly the kind of run
    // `evaluateCircuitBreaker`'s `consecutiveFailures` threshold exists to
    // stop for operator review, same as repeated permanent failures.
    this.#planRunStore.recordCircuitOutcome({
      runId: run.id,
      failureCode: classification,
      isNoProgress,
    });
    const circuit = this.#planRunStore.getCircuitState(run.id);
    const evaluation = evaluateCircuitBreaker({
      policy: run.policySnapshot,
      consecutiveFailures: circuit.consecutiveFailures,
      consecutiveSameCodeFailures: circuit.consecutiveSameCodeFailures,
      noProgressAttempts: circuit.noProgressAttempts,
    });
    if (evaluation.shouldTrip && evaluation.reason) {
      this.#planRunStore.tripCircuit({ runId: run.id, reason: evaluation.reason, stepId, now });
      this.#appendEvent(run.id, "ceo.execution.circuit_opened", {
        planStepId: stepId,
        reason: evaluation.reason,
      });
      this.#pauseForIntervention(run.id, "circuit-open");
      return;
    }

    const retry = decideRetry({ classification, policy: run.policySnapshot, attemptNumber }, now);
    if (retry.shouldRetry && retry.nextEligibleAt) {
      this.#planRunStore.upsertStepExecution({
        runId: run.id,
        planStepId: stepId,
        status: "retry_wait",
        readinessReason: "ready",
        dependencySummary,
        nextEligibleAt: retry.nextEligibleAt,
      });
      // Phase 15.3 — see the matching enqueue (and its doc comment) in
      // `#handleChildTaskFailure`.
      this.#enqueueSignalSync({
        planRunId: run.id,
        planStepId: stepId,
        reason: "retry_due",
        delaySeconds: run.policySnapshot.retryBackoffSeconds,
      });
      this.#appendEvent(run.id, "ceo.execution.retry_scheduled", { planStepId: stepId });
    } else if (run.policySnapshot.pauseOnAnyPermanentFailure) {
      this.#pauseForIntervention(run.id, "step-failed");
    }
  }

  #recordFingerprintAndCheckProgress(
    runId: string,
    stepId: string,
    input: Parameters<typeof computeProgressFingerprint>[0],
  ): boolean {
    const key = `${runId} ${stepId}`;
    const fingerprint = computeProgressFingerprint(input);
    const previous = this.#progressFingerprints.get(key);
    this.#progressFingerprints.set(key, fingerprint);
    return previous === fingerprint;
  }

  #pauseForIntervention(runId: string, _reason: string): void {
    const run = this.#planRunStore.findRun(runId);
    if (run?.status !== "running") return;
    this.#runAtomicUnit(() => {
      this.#planRunStore.recoveryPauseRun({ runId, now: this.#now(), classification: "none" });
      this.#signalStore.cancelSignalsForRun(runId, this.#now());
    });
    this.#postAuditOnce(
      run.planId,
      runId,
      "intervention_required",
      "Autonomous execution paused and requires operator attention.",
    );
  }

  #maybeCompleteRun(runId: string): void {
    const run = this.#planRunStore.findRun(runId);
    if (run?.status !== "running") return;
    const steps = this.#planRunStore.listStepExecutions(runId);
    if (steps.length > 0 && steps.every((s) => s.status === "completed")) {
      this.#planRunStore.completeRun({ runId, now: this.#now() });
      this.#appendEvent(runId, "ceo.execution.completed", {});
      this.#postAuditOnce(
        run.planId,
        runId,
        "execution_completed",
        "Autonomous execution completed successfully.",
      );
    }
  }

  /** Called by composition's task-mutation-hook bridge when a delegated child task reaches a terminal or otherwise relevant status — the actual event-first entry point for "a task changed" (as opposed to operator-driven signals). */
  async onChildTaskMutated(childTaskId: string): Promise<void> {
    const stepExecutions = this.#planRunStore.listStepExecutionsByChildTask(childTaskId);
    for (const stepExecution of stepExecutions) {
      const run = this.#planRunStore.findRun(stepExecution.planRunId);
      // An explicit allow-list, not "not terminal" — a run still
      // `"configured"` (never started) must stay excluded exactly like
      // before, or a child task started manually from the Kanban board
      // ahead of `Start execution…` would get its step-execution row
      // marked "completed"/"cancelled" here, and `#tryAdvanceStep` would
      // then treat that step as already resolved the moment the run
      // actually starts — satisfied without ever claiming a real attempt.
      // "paused" and "awaiting_intervention" DO need to reach here: both
      // are what a run still linked to a genuinely in-flight child task
      // moves to SYNCHRONOUSLY (pause, cancel-future-scheduling, emergency
      // stop, or Phase 13's own unclean-restart recovery), before that
      // task's async completion/cancellation actually lands — requiring
      // `run.status === "running"` here silently dropped the step's
      // terminal-status reconciliation forever whenever it arrived after
      // one of those transitions (the step-execution row stayed stuck on
      // "running" even once its child task genuinely finished — the real
      // root cause of a reproduced emergency-stop defect, not a test
      // flake). Recording the step's own observed terminal status is
      // always safe in either state; only the "what happens next" logic
      // below (auto-drain, retry scheduling, circuit-breaker trip,
      // pause-for-intervention) is further gated on `run.status ===
      // "running"`, so a paused/stopped/awaiting-intervention run is never
      // resumed or advanced as a side effect of this — including never
      // undoing Phase 13's unclean-restart rule that interrupted provider
      // work is never automatically resumed or retried.
      if (run === undefined) continue;
      if (!["running", "paused", "awaiting_intervention"].includes(run.status)) continue;
      // Idempotency guard, the same shape as `#tryAdvanceStep`'s own
      // terminal-status check: a step already resolved to a terminal
      // status, OR already parked in `retry_wait` off the back of this
      // exact task's earlier real "failed" status, must never be
      // reprocessed by a second/duplicate delivery of the same
      // underlying task mutation — without this, a best-effort bridge
      // that calls this method more than once for one real failure
      // would double-count circuit-breaker counters and double-append
      // audit events, even though nothing about the step's own state
      // actually changed again. `retry_wait` belongs here specifically
      // because its underlying child task is already genuinely
      // `"failed"` (unlike `awaiting_intervention` reached via other
      // paths, which never coincides with this task itself being
      // terminal) — a second delivery for that same task would
      // otherwise walk straight back into `#handleChildTaskFailure`.
      if (["completed", "failed", "cancelled", "retry_wait"].includes(stepExecution.status)) {
        continue;
      }
      let taskRecord;
      try {
        taskRecord = this.#taskStore.get(childTaskId);
      } catch {
        continue;
      }
      if (taskRecord.task.status === "completed") {
        // The event append deliberately happens AFTER this atomic span
        // (never inside it): the span's job is protecting the run's
        // functional state (step status + queued signal) — an event
        // append failing after that state has genuinely committed is a
        // lesser, audit-trail-only gap, never a state-corruption risk,
        // and keeping it out of the span is what lets `#appendEvent`
        // publish to `PlanRunEventBus` immediately and safely (it can
        // never be called from inside a still-open atomic span).
        // The step's own observed status is always recorded — but a
        // background task completing while the run is no longer
        // "running" (paused / awaiting_intervention, reached after this
        // task was already started) must never auto-advance the DAG on
        // its own; only a run still actively "running" gets the queued
        // `task_terminal` signal.
        const wasRunning = run.status === "running";
        this.#runAtomicUnit(() => {
          // Phase 15.2 — finalize the ATTEMPT row itself alongside the
          // step execution; see the matching fix (and its doc comment)
          // in `#handleChildTaskFailure` for why this was previously
          // missing and why attempt history needs it to stay accurate.
          // Phase 15.3 — reads `activeAttemptId` fresh here rather than
          // trusting the `onChildTaskMutated`-entry snapshot; see
          // `#handleChildTaskFailure`'s matching fix for why.
          const currentActiveAttemptId = this.#planRunStore.getStepExecution(
            run.id,
            stepExecution.planStepId,
          ).activeAttemptId;
          if (currentActiveAttemptId !== undefined) {
            this.#planRunStore.updateAttempt({
              attemptId: currentActiveAttemptId,
              status: "completed",
              now: this.#now(),
              finishedAt: this.#now(),
            });
          }
          this.#planRunStore.upsertStepExecution({
            runId: run.id,
            planStepId: stepExecution.planStepId,
            status: "completed",
            readinessReason: "completed",
            dependencySummary: stepExecution.dependencySummary,
            completedAt: this.#now(),
          });
          // The one legitimate reset: this step's child task genuinely
          // reached "completed" — durable, already-persisted evidence of
          // real progress, never merely "another attempt started" (see
          // the doc comment on the removed launch-time call in
          // `#tryAdvanceStep`).
          this.#planRunStore.recordCircuitProgress(run.id);
          if (wasRunning) {
            this.#enqueueSignalSync({
              planRunId: run.id,
              planStepId: stepExecution.planStepId,
              reason: "task_terminal",
            });
          }
        });
        this.#appendEvent(run.id, "ceo.execution.step_completed", {
          planStepId: stepExecution.planStepId,
        });
        if (taskRecord.adapterId !== undefined) {
          await this.#wakeCapacityWaiters(taskRecord.adapterId, run.id);
        }
        if (wasRunning) {
          await this.#drain();
        }
      } else if (taskRecord.task.status === "failed") {
        await this.#handleChildTaskFailure(run, stepExecution, taskRecord);
      } else if (taskRecord.task.status === "cancelled") {
        // Same "always record, only advance if still running" split as
        // the `"completed"` branch above — this is the exact path a
        // task cancelled via emergency stop lands on: `emergencyStop()`
        // pauses the run SYNCHRONOUSLY before the cancellation it
        // requests actually resolves, so by the time this handler runs,
        // `run.status` is already `"paused"`, not `"running"`.
        const wasRunning = run.status === "running";
        this.#runAtomicUnit(() => {
          // Phase 15.2 — see the matching fix in the "completed" branch
          // above and in `#handleChildTaskFailure`. Phase 15.3 — reads
          // `activeAttemptId` fresh here too; see `#handleChildTaskFailure`.
          const currentActiveAttemptId = this.#planRunStore.getStepExecution(
            run.id,
            stepExecution.planStepId,
          ).activeAttemptId;
          if (currentActiveAttemptId !== undefined) {
            this.#planRunStore.updateAttempt({
              attemptId: currentActiveAttemptId,
              status: "cancelled",
              now: this.#now(),
              finishedAt: this.#now(),
            });
          }
          this.#planRunStore.upsertStepExecution({
            runId: run.id,
            planStepId: stepExecution.planStepId,
            status: "cancelled",
            readinessReason: "cancelled",
            dependencySummary: stepExecution.dependencySummary,
            completedAt: this.#now(),
          });
          if (wasRunning && !run.policySnapshot.pauseOnAnyPermanentFailure) {
            this.#enqueueSignalSync({
              planRunId: run.id,
              planStepId: stepExecution.planStepId,
              reason: "task_terminal",
            });
          }
        });
        this.#appendEvent(run.id, "ceo.execution.step_failed", {
          planStepId: stepExecution.planStepId,
        });
        if (taskRecord.adapterId !== undefined) {
          await this.#wakeCapacityWaiters(taskRecord.adapterId, run.id);
        }
        if (wasRunning && run.policySnapshot.pauseOnAnyPermanentFailure) {
          this.#pauseForIntervention(run.id, "child-task-terminal-failure");
        } else if (wasRunning) {
          await this.#drain();
        }
      }
    }
  }

  /**
   * A child task that actually ran and then failed — as opposed to
   * `#handleStartFailure`, which only handles a failure to START one
   * (adapter-unavailable / `TaskOrchestrator.startTask` throwing). This
   * is the one place `onChildTaskMutated` classifies a real run failure,
   * feeds the circuit breaker, and decides whether to schedule an
   * automatic retry — closing a gap where this path previously marked
   * the step `"failed"` directly with none of that machinery. See
   * `docs/architecture/0015-...md`, "Known Phase-15 limitations" for why
   * a scheduled retry is only *reconsidered* on some later signal for
   * this run, not woken up on its own timer.
   */
  async #handleChildTaskFailure(
    run: CeoPlanRun,
    stepExecution: CeoPlanStepExecution,
    taskRecord: TaskRecord,
  ): Promise<void> {
    const classification = classifyExecutionFailure({
      kind: "structured_failure",
      failure: taskRecord.failure ?? {
        code: "TASK_FAILED",
        message: "Child task failed with no structured failure recorded.",
        retryable: false,
      },
    });
    const now = this.#now();
    const isNoProgress = this.#recordFingerprintAndCheckProgress(run.id, stepExecution.planStepId, {
      childTaskStatus: taskRecord.task.status,
      lastEventSequence: taskRecord.lastSequence,
      hasTerminalResultEvidence: taskRecord.terminalEventType !== undefined,
      dependencyCompletedCount: stepExecution.dependencySummary.completedDependencies,
    });
    // Same "always record, only advance if still running" split as the
    // `"completed"`/`"cancelled"` branches in `onChildTaskMutated` — a
    // task that fails while the run is no longer "running" (paused /
    // awaiting_intervention) must still have its own terminal status
    // recorded, but must never trip the circuit breaker, schedule a
    // retry, or pause-for-intervention a run that's already stopped.
    const wasRunning = run.status === "running";

    const outcome = this.#runAtomicUnit(
      ():
        | { readonly kind: "tripped"; readonly reason: CeoPlanExecutionCircuitTripReason }
        | { readonly kind: "retry_scheduled" }
        | { readonly kind: "terminal" } => {
        // Phase 15.2 — finalize the ATTEMPT row itself, not just the step
        // execution. Previously this never happened for a real run
        // failure (only `#handleStartFailure`'s launch-time path called
        // `updateAttempt`), leaving attempt 1's own history stuck at
        // `"running"` forever — which is also precisely why governed
        // retry's "previous attempt terminal" precondition could never
        // pass.
        //
        // Phase 15.3 — reads `activeAttemptId` FRESH from the store here
        // rather than trusting `stepExecution.activeAttemptId` (a
        // snapshot `onChildTaskMutated` took at its own entry, before
        // this atomic block runs). `claimAttempt()` sets it synchronously
        // at claim time, well before this task could possibly reach a
        // terminal status, so the two should never actually differ — but
        // a caller-supplied snapshot has no staleness guarantee the way a
        // read taken immediately before the write it gates does, and this
        // is the one place a stale `undefined` here would silently skip
        // finalizing the attempt row (leaving it wedged at `"running"`
        // forever, exactly the shape of a real defect this session
        // investigated but could not deterministically reproduce — see
        // `docs/architecture/0015-...md`, "Known Phase-15 limitations").
        const currentActiveAttemptId = this.#planRunStore.getStepExecution(
          run.id,
          stepExecution.planStepId,
        ).activeAttemptId;
        if (currentActiveAttemptId !== undefined) {
          this.#planRunStore.updateAttempt({
            attemptId: currentActiveAttemptId,
            status: "failed",
            now,
            safeFailureCode: classification,
            safeFailureSummary: taskRecord.failure?.message,
            finishedAt: now,
          });
        }
        this.#planRunStore.upsertStepExecution({
          runId: run.id,
          planStepId: stepExecution.planStepId,
          status: "failed",
          readinessReason: "ready",
          dependencySummary: stepExecution.dependencySummary,
          completedAt: now,
          lastFailureCode: classification,
        });
        if (!wasRunning) return { kind: "terminal" };
        this.#planRunStore.recordCircuitOutcome({
          runId: run.id,
          failureCode: classification,
          isNoProgress,
        });
        const circuit = this.#planRunStore.getCircuitState(run.id);
        const evaluation = evaluateCircuitBreaker({
          policy: run.policySnapshot,
          consecutiveFailures: circuit.consecutiveFailures,
          consecutiveSameCodeFailures: circuit.consecutiveSameCodeFailures,
          noProgressAttempts: circuit.noProgressAttempts,
        });
        if (evaluation.shouldTrip && evaluation.reason) {
          this.#planRunStore.tripCircuit({
            runId: run.id,
            reason: evaluation.reason,
            stepId: stepExecution.planStepId,
            now,
          });
          return { kind: "tripped", reason: evaluation.reason };
        }

        // Evaluated BEFORE the `pauseOnAnyPermanentFailure` branch below —
        // a legitimate transient retry must never be pre-empted by a
        // pause-on-permanent-failure policy that was never meant to apply
        // to it.
        const retry = decideRetry(
          { classification, policy: run.policySnapshot, attemptNumber: stepExecution.attemptCount },
          now,
        );
        if (retry.shouldRetry && retry.nextEligibleAt) {
          this.#planRunStore.upsertStepExecution({
            runId: run.id,
            planStepId: stepExecution.planStepId,
            status: "retry_wait",
            readinessReason: "ready",
            dependencySummary: stepExecution.dependencySummary,
            nextEligibleAt: retry.nextEligibleAt,
          });
          // Phase 15.3 — a durable, delayed `"retry_due"` signal is what
          // makes this step self-waking: without it, nothing ever
          // reconsiders a `retry_wait` step once `nextEligibleAt` passes
          // except some UNRELATED signal for this run happening to arrive
          // (see the retry-circuit E2E spec's own history). `#now()` is
          // re-read here rather than reusing `now` captured at method
          // entry — negligible drift, but `delaySeconds` must be relative
          // to the moment this signal is actually inserted, not to the
          // failure timestamp a few synchronous statements earlier.
          this.#enqueueSignalSync({
            planRunId: run.id,
            planStepId: stepExecution.planStepId,
            reason: "retry_due",
            delaySeconds: run.policySnapshot.retryBackoffSeconds,
          });
          return { kind: "retry_scheduled" };
        }

        if (!run.policySnapshot.pauseOnAnyPermanentFailure) {
          this.#enqueueSignalSync({
            planRunId: run.id,
            planStepId: stepExecution.planStepId,
            reason: "task_terminal",
          });
        }
        return { kind: "terminal" };
      },
    );

    this.#appendEvent(run.id, "ceo.execution.step_failed", {
      planStepId: stepExecution.planStepId,
      safeFailureCode: classification,
    });
    // The underlying child task is already `"failed"` (a terminal
    // status) regardless of what happens next to the STEP (tripped /
    // retry_scheduled / terminal) — its adapter slot is free the moment
    // we get here, so other runs waiting on this adapter must be woken
    // in every branch, not just the terminal one.
    if (taskRecord.adapterId !== undefined) {
      await this.#wakeCapacityWaiters(taskRecord.adapterId, run.id);
    }

    if (outcome.kind === "tripped") {
      this.#appendEvent(run.id, "ceo.execution.circuit_opened", {
        planStepId: stepExecution.planStepId,
        reason: outcome.reason,
      });
      this.#pauseForIntervention(run.id, "circuit-open");
      return;
    }
    if (outcome.kind === "retry_scheduled") {
      this.#appendEvent(run.id, "ceo.execution.retry_scheduled", {
        planStepId: stepExecution.planStepId,
      });
      return;
    }
    if (wasRunning && run.policySnapshot.pauseOnAnyPermanentFailure) {
      this.#pauseForIntervention(run.id, "child-task-terminal-failure");
    } else if (wasRunning) {
      await this.#drain();
    }
  }

  /**
   * A separate, explicit, destructive action from `pauseRun` — see the
   * kickoff's "Pause semantics": pausing stops future scheduling and
   * leaves active runs untouched; this stops future scheduling AND
   * attempts to cancel every currently active ("claimed"/"starting"/
   * "running") step's linked child task, using
   * `TaskOrchestrator.requestCancellation` — the exact same cancellation
   * path a human clicking "Cancel task" on the Kanban board already uses,
   * never a bypass of it. Scoped strictly to THIS run's own linked child
   * tasks via `listStepExecutions(runId)`; an unrelated task, or a task
   * belonging to a different plan run, is never touched. Records each
   * outcome individually and never reports overall success
   * (`allSucceeded`) if even one linked active task could not be
   * cancelled — the caller is responsible for surfacing that to the
   * operator, per the kickoff's "never report success if one active run
   * couldn't be cancelled."
   */
  emergencyStop(runId: string): EmergencyStopResult {
    const run = this.#planRunStore.getRun(runId);
    if (CEO_PLAN_RUN_TERMINAL_STATUSES.includes(run.status)) {
      throw new CeoPlanRunStateConflictError(runId, run.status, "emergency-stopped");
    }
    if (run.status === "running") {
      this.#runAtomicUnit(() => {
        this.#planRunStore.pauseRun({ runId, now: this.#now() });
        this.#signalStore.cancelSignalsForRun(runId, this.#now());
      });
    }

    const activeStatuses = new Set(["claimed", "starting", "running"]);
    const activeSteps = this.#planRunStore
      .listStepExecutions(runId)
      .filter((step) => activeStatuses.has(step.status));

    const outcomes: EmergencyStopOutcome[] = [];
    for (const step of activeSteps) {
      try {
        const result = this.#taskOrchestrator.requestCancellation(step.childTaskId);
        outcomes.push({
          planStepId: step.planStepId,
          childTaskId: step.childTaskId,
          outcome: result.alreadyRequested ? "already_requested" : "cancellation_requested",
        });
      } catch (error) {
        outcomes.push({
          planStepId: step.planStepId,
          childTaskId: step.childTaskId,
          outcome: "failed",
          detail: safeMessage(error),
        });
      }
    }

    const allSucceeded = outcomes.every((outcome) => outcome.outcome !== "failed");
    this.#appendEvent(runId, "ceo.execution.emergency_stop_requested", {
      linkedActiveCount: activeSteps.length,
      allSucceeded,
    });
    this.#postBoardAudit(
      run.planId,
      allSucceeded
        ? `Emergency stop requested cancellation for ${String(activeSteps.length)} linked active task(s).`
        : `Emergency stop requested cancellation for ${String(activeSteps.length)} linked active task(s); one or more could not be cancelled and needs review.`,
    );

    return { runId, outcomes, allSucceeded };
  }

  /**
   * Persists, then immediately publishes to `PlanRunEventBus` — safe
   * only because this method is never called from inside a still-open
   * `runAtomicUnit` span anywhere in this class (see `SchedulerDeps
   * .eventBus`'s doc comment); every call site appends strictly after
   * the state-changing atomic span it relates to has already committed.
   */
  #appendEvent(
    runId: string,
    type: Parameters<CeoPlanRunStorePort["appendEvent"]>[0]["type"],
    payload: Record<string, string | number | boolean | null>,
  ): void {
    const event = this.#planRunStore.appendEvent({
      runId,
      type,
      actor: SCHEDULER_ACTOR,
      payload,
      now: this.#now(),
    });
    this.#eventBus?.publish(runId, event);
  }

  #postAuditOnce(planId: string, runId: string, dedupKey: string, text: string): void {
    if (this.#planRunStore.claimBoardAuditOnce(runId, dedupKey, this.#now())) {
      this.#postBoardAudit(planId, text);
    }
  }
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return "An unexpected error occurred while starting this step.";
}
