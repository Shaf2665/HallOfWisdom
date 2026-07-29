import { isTerminalEventType } from "@hall-of-wisdom/hall-runner";
import type {
  CandidateStatus,
  ComparisonCandidateRecord,
} from "../comparisons/comparison-record.js";
import type { ComparisonStorePort } from "../comparisons/comparison-store-port.js";
import type { NormalizedEventStorePort } from "../events/event-store-port.js";
import { EventStoreError } from "../events/event-store-errors.js";
import { buildInfrastructureFailureEvent } from "../events/synthetic-events.js";

export const RESTART_INTERRUPTED_CANDIDATE_RUN_CODE = "HALL_RESTART_INTERRUPTED_RUN";
export const RESTART_INTERRUPTED_PREPARATION_CODE = "HALL_RESTART_INTERRUPTED_PREPARATION";

const TERMINAL_CANDIDATE_STATUSES: ReadonlySet<CandidateStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export interface ComparisonReconciliationSummary {
  readonly comparisonsScanned: number;
  readonly interruptedPreparationsMarkedFailed: readonly string[];
  readonly interruptedCleanupsMarkedFailed: readonly string[];
  readonly eventProjectionsRepaired: number;
  readonly terminalOutcomesReplayed: number;
  readonly interruptedCandidateRunsMarkedFailed: readonly string[];
}

/**
 * The comparison-side mirror of `reconcileTasks` — see that function's doc
 * comment for why event-count/status reconciliation is done by replaying
 * each store's own already-idempotent methods against the events table
 * (the source of truth) rather than requiring cross-store transactional
 * atomicity. Two comparison-specific cases `TaskStore` has no equivalent
 * of, handled first because neither depends on any candidate having a
 * `runId`:
 *
 * - `status: "preparing"` at startup can only mean the request that called
 *   `prepareComparison()` never finished (that method runs synchronously
 *   from claim to `setReady`/`setPrepareFailed` with no other request able
 *   to touch the same comparison in between) — it is failed outright, never
 *   resumed, exactly like an interrupted task/candidate run.
 * - `cleanupStatus: "in_progress"` at startup means `cleanupComparison()`
 *   was interrupted mid-teardown; marked `setCleanupFailed` (which does not
 *   touch `status`) so a subsequent `DELETE` can retry — worktree removal
 *   is idempotent and safe to attempt again, unlike a provider run.
 *
 * Both checks are keyed off currently-persisted state (not the previous
 * boot's shutdown marker), so a second consecutive unclean restart is a
 * no-op for a comparison already reconciled by the first.
 */
export function reconcileComparisons(
  comparisonStore: ComparisonStorePort,
  eventStore: NormalizedEventStorePort,
): ComparisonReconciliationSummary {
  const comparisons = comparisonStore.list();
  const interruptedPreparationsMarkedFailed: string[] = [];
  const interruptedCleanupsMarkedFailed: string[] = [];
  const interruptedCandidateRunsMarkedFailed: string[] = [];
  let eventProjectionsRepaired = 0;
  let terminalOutcomesReplayed = 0;

  for (const initial of comparisons) {
    const comparisonId = initial.comparisonId;

    if (initial.status === "preparing") {
      comparisonStore.setPrepareFailed(
        comparisonId,
        undefined,
        RESTART_INTERRUPTED_PREPARATION_CODE,
        "Comparison preparation was interrupted by a Hall Core restart and cannot be resumed.",
      );
      interruptedPreparationsMarkedFailed.push(comparisonId);
    }

    if (initial.cleanupStatus === "in_progress") {
      comparisonStore.setCleanupFailed(
        comparisonId,
        "Cleanup was interrupted by a Hall Core restart. Retry cleanup.",
      );
      interruptedCleanupsMarkedFailed.push(comparisonId);
    }

    for (const initialCandidate of initial.candidates) {
      const candidateId = initialCandidate.candidateId;
      const actualEvents = eventStore.list(candidateId);

      if (actualEvents.length > initialCandidate.eventCount) {
        for (const event of actualEvents.slice(initialCandidate.eventCount)) {
          comparisonStore.recordCandidateEventMeta(comparisonId, candidateId, event.sequence);
        }
        eventProjectionsRepaired += 1;
      }

      const candidate = comparisonStore
        .get(comparisonId)
        .candidates.find((entry) => entry.candidateId === candidateId);
      if (candidate === undefined || TERMINAL_CANDIDATE_STATUSES.has(candidate.status)) continue;

      const lastEvent = actualEvents.at(-1);
      if (lastEvent !== undefined && isTerminalEventType(lastEvent.type)) {
        // See `reconcile-tasks.ts`'s identical guard for why this is
        // wrapped: recovery runs before the server accepts a single
        // request, so any unexpected failure here must fall through to the
        // interrupted-run path below rather than brick startup.
        try {
          comparisonStore.setCandidateCompleted(comparisonId, candidateId, {
            completedAt: lastEvent.timestamp,
            terminalEventType: lastEvent.type,
            failure: lastEvent.type === "run.failed" ? lastEvent.payload.failure : undefined,
          });
          terminalOutcomesReplayed += 1;
          continue;
        } catch (error) {
          console.error(
            `Recovery could not replay the terminal outcome for candidate "${candidateId}"; falling back to marking it interrupted: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const stillNonTerminal = comparisonStore
        .get(comparisonId)
        .candidates.find((entry) => entry.candidateId === candidateId);
      if (
        stillNonTerminal !== undefined &&
        !TERMINAL_CANDIDATE_STATUSES.has(stillNonTerminal.status) &&
        stillNonTerminal.runId !== undefined
      ) {
        const marked = recordInterruptedCandidateRun(
          comparisonStore,
          eventStore,
          comparisonId,
          candidateId,
          stillNonTerminal,
        );
        if (marked) interruptedCandidateRunsMarkedFailed.push(candidateId);
      }
    }
  }

  return {
    comparisonsScanned: comparisons.length,
    interruptedPreparationsMarkedFailed,
    interruptedCleanupsMarkedFailed,
    eventProjectionsRepaired,
    terminalOutcomesReplayed,
    interruptedCandidateRunsMarkedFailed,
  };
}

function recordInterruptedCandidateRun(
  comparisonStore: ComparisonStorePort,
  eventStore: NormalizedEventStorePort,
  comparisonId: string,
  candidateId: string,
  candidate: ComparisonCandidateRecord,
): boolean {
  if (candidate.runId === undefined || candidate.agentId === undefined) {
    console.error(
      `Recovery cannot mark candidate "${candidateId}" interrupted: it has no run recorded.`,
    );
    return false;
  }

  const failureEvent = buildInfrastructureFailureEvent({
    runId: candidate.runId,
    taskId: candidateId,
    agentId: candidate.agentId,
    sequence: eventStore.nextSequence(candidateId),
    code: RESTART_INTERRUPTED_CANDIDATE_RUN_CODE,
    message: "This candidate's run was interrupted by a Hall Core restart and was not resumed.",
  });

  try {
    const result = eventStore.append(candidateId, failureEvent, {
      runId: candidate.runId,
      taskId: candidateId,
      agentId: candidate.agentId,
    });
    if (result.stored) {
      comparisonStore.recordCandidateEventMeta(comparisonId, candidateId, failureEvent.sequence);
    }
  } catch (error) {
    if (!(error instanceof EventStoreError)) throw error;
    console.error(
      `Recovery could not store the interrupted-run event for candidate "${candidateId}": ${error.message}`,
    );
  }

  comparisonStore.setCandidateCompleted(comparisonId, candidateId, {
    completedAt: failureEvent.timestamp,
    terminalEventType: "run.failed",
    failure: failureEvent.payload.failure,
  });
  return true;
}
