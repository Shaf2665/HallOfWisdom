import type {
  CeoPlanExecutionSignal,
  CeoPlanExecutionSignalPriority,
  CeoPlanExecutionTriggerReason,
} from "@hall-of-wisdom/protocol";

/**
 * Durable, coalescing execution-signal queue. Deliberately a separate
 * store from `CeoPlanRunStorePort` — signals have their own high-churn
 * claim/coalesce lifecycle distinct from run/step/attempt state (see
 * `docs/architecture/0015-autonomous-plan-execution-and-scheduling.md`,
 * "Durable execution-signal queue").
 *
 * Coalescing key: `(planRunId, planStepId ?? plan-level, generation)`.
 * `enqueue` either inserts a brand-new pending signal or merges into an
 * existing pending one for the same key — in SQLite mode this is enforced
 * atomically by migration 5's partial unique index
 * (`idx_ceo_plan_execution_signals_coalesce`); in ephemeral mode by a
 * synchronous map lookup-then-write with no `await` gap.
 */
export interface EnqueueSignalInput {
  readonly signalId: string;
  readonly planRunId: string;
  readonly planStepId: string | undefined;
  readonly generation: number;
  readonly reason: CeoPlanExecutionTriggerReason;
  readonly priority: CeoPlanExecutionSignalPriority;
  readonly availableAt: string;
  readonly now: string;
}

export interface EnqueueSignalResult {
  readonly signal: CeoPlanExecutionSignal;
  /** `true` if this call created a brand-new pending signal; `false` if it merged into an already-pending one (coalesced). */
  readonly created: boolean;
}

export interface ClaimNextSignalInput {
  readonly now: string;
  readonly ownerToken: string;
  readonly leaseSeconds: number;
  /** Only claim signals belonging to one of these run ids — the scheduler always knows which runs it is actively servicing (never a global, unscoped claim across every plan in the system, keeping claim queries bounded). */
  readonly eligibleRunIds: readonly string[];
}

export interface ClaimedSignal {
  readonly signal: CeoPlanExecutionSignal;
  readonly claimLease: string;
}

export interface ExecutionSignalStorePort {
  enqueue(input: EnqueueSignalInput): EnqueueSignalResult;

  /**
   * Atomically claims at most one pending, currently-available (`availableAt <= now`),
   * highest-priority-then-oldest signal among `eligibleRunIds`, marking it
   * `claimed` under the given lease. Returns `undefined` if none are
   * claimable right now. `releaseExpiredClaims` must be called (or run as
   * part of this method) first so a crashed claimant's lease cannot
   * starve the queue forever.
   */
  claimNext(input: ClaimNextSignalInput): ClaimedSignal | undefined;

  /** Marks a claimed signal fully processed — terminal, never reclaimed. */
  markProcessed(signalId: string, claimLease: string, now: string): void;

  /** Releases a claim without marking the signal processed (e.g. the claimant discovered the signal's generation is now stale) — the signal returns to `pending` so a future tick can reconsider it fresh. */
  releaseClaim(signalId: string, claimLease: string, now: string): void;

  /** Conservative recovery: any claim whose lease has expired (crashed or displaced claimant) is returned to `pending`. Called before every claim attempt and by the periodic reconciliation pass. */
  releaseExpiredClaims(now: string): number;

  /** Cancels every pending/claimed signal for a run — used when a run is paused/cancelled/recovery-paused, so a stale generation's signals never get acted on. */
  cancelSignalsForRun(planRunId: string, now: string): number;

  /**
   * Phase 15.2 — cancels every pending/claimed signal for one specific
   * step within a run (never touches signals for other steps, or the
   * plan-level `planStepId: undefined` signal) — used when
   * `TaskOrchestrator.startTask()`'s final launch validation rejects a
   * step for a never-auto-retry reason (capability/execution-trust/
   * requirements/assignment drift): any other signal already coalesced or
   * queued for this exact step is now obsolete (the step just moved to
   * `awaiting_intervention` and will never be retried automatically), and
   * must not silently trigger a second launch attempt later. Narrower
   * than `cancelSignalsForRun` — the rest of the run keeps executing.
   */
  cancelSignalsForStep(planRunId: string, planStepId: string, now: string): number;

  getSignal(signalId: string): CeoPlanExecutionSignal | undefined;
  listSignalsForRun(planRunId: string): readonly CeoPlanExecutionSignal[];

  /** Safe, bounded counts for `GET .../scheduler-status` — never enumerates full rows. */
  countByState(): { readonly pending: number; readonly claimed: number };

  /**
   * Phase 15.3 — the `availableAt` of the single soonest-due pending
   * signal across every run, or `undefined` if none are pending. Backs
   * the scheduler's retry-due wake timer: rather than a per-task timer or
   * a busy poll, the scheduler arms exactly one timer for this value,
   * re-arming it whenever a signal with an earlier `availableAt` is
   * inserted. A bounded min-lookup (indexed in SQLite, a linear scan over
   * the — typically tiny — in-memory pending set), never a full table
   * scan proportional to signal history.
   */
  nextPendingAvailableAt(): string | undefined;
}
