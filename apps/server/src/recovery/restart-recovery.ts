import type { HallDatabase } from "../persistence/database.js";
import { checkOrRecordConfigurationFingerprint } from "../persistence/server-metadata-repository.js";
import {
  getPreviousBoot,
  recordBootStarted,
  recordRecoverySummary,
} from "../persistence/boot-repository.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { ComparisonStorePort } from "../comparisons/comparison-store-port.js";
import type { ComparisonInternalPathsPort } from "../comparisons/comparison-internal-paths-port.js";
import type { NormalizedEventStorePort } from "../events/event-store-port.js";
import type { GitWorktreeManager } from "../comparisons/git-worktree-manager.js";
import { reconcileTasks } from "./reconcile-tasks.js";
import { reconcileComparisons } from "./reconcile-comparisons.js";
import {
  classifyComparisonWorktrees,
  scanOrphanWorktrees,
  type WorktreeHealth,
} from "./classify-comparison-worktrees.js";

export type PreviousShutdownKind = "clean" | "unclean" | "first_start";

export interface RecoverySummary {
  readonly bootId: string;
  readonly previousShutdown: PreviousShutdownKind;
  readonly tasksScanned: number;
  readonly taskEventProjectionsRepaired: number;
  readonly taskTerminalOutcomesReplayed: number;
  readonly interruptedTaskRunCount: number;
  readonly comparisonsScanned: number;
  readonly interruptedPreparationCount: number;
  readonly interruptedCleanupCount: number;
  readonly comparisonEventProjectionsRepaired: number;
  readonly comparisonTerminalOutcomesReplayed: number;
  readonly interruptedCandidateRunCount: number;
  readonly worktreeHealthCounts: Readonly<Record<WorktreeHealth, number>>;
  readonly orphanWorktreeCount: number;
}

export interface RestartRecoveryComparisonInput {
  readonly comparisonStore: ComparisonStorePort;
  readonly comparisonEventStore: NormalizedEventStorePort;
  readonly comparisonInternalPaths: ComparisonInternalPathsPort;
  readonly gitWorktreeManager: GitWorktreeManager;
}

export interface RestartRecoveryInput {
  readonly db: HallDatabase;
  readonly bootId: string;
  readonly startedAt: string;
  readonly workspaceRoot: string;
  readonly comparisonRoot: string | undefined;
  readonly taskStore: TaskStorePort;
  readonly taskEventStore: NormalizedEventStorePort;
  /** `undefined` when this Hall Core instance was not configured with comparisons enabled (no `--comparison-root`) — comparison reconciliation, worktree classification, and orphan scanning are all skipped entirely. */
  readonly comparison: RestartRecoveryComparisonInput | undefined;
}

export interface RestartRecoveryResult {
  readonly summary: RecoverySummary;
  /** Feed directly to `ComparisonOrchestrator.rehydrateInternalPaths()` — see that method's doc comment. */
  readonly internalPathsForRehydration: {
    readonly sourceRepositoryPaths: readonly {
      readonly comparisonId: string;
      readonly sourceRepositoryPath: string;
    }[];
    readonly worktreePaths: readonly {
      readonly candidateId: string;
      readonly worktreePath: string;
    }[];
  };
}

const EMPTY_WORKTREE_HEALTH_COUNTS: Record<WorktreeHealth, number> = {
  healthy: 0,
  interrupted: 0,
  workspace_missing: 0,
  workspace_unverified: 0,
  cleanup_required: 0,
  unsafe_path: 0,
};

/**
 * The full durable-mode startup recovery sequence — called once by
 * composition, before the server accepts requests. Order matters:
 *
 * 1. Configuration fingerprint (fail closed on a reused database created
 *    for different roots — see `server-metadata-repository.ts`).
 * 2. Determine the previous boot's shutdown cleanliness (for the status
 *    page only — never gates whether reconciliation runs; see
 *    `reconcile-tasks.ts`'s doc comment on why reconciliation is
 *    unconditional).
 * 3. Record this boot.
 * 4. Reconcile tasks, then comparisons (event-projection catch-up,
 *    terminal-outcome replay, interrupted-run/preparation/cleanup
 *    handling) — comparisons after tasks only for summary ordering; the
 *    two are otherwise independent.
 * 5. Classify every persisted candidate worktree's on-disk health and scan
 *    for orphaned worktree directories — read-only, never deletes.
 * 6. Persist a bounded, path-free recovery summary on this boot's row.
 */
export async function runRestartRecovery(
  input: RestartRecoveryInput,
): Promise<RestartRecoveryResult> {
  checkOrRecordConfigurationFingerprint(input.db, {
    workspaceRoot: input.workspaceRoot,
    comparisonRoot: input.comparisonRoot,
  });

  const previousBoot = getPreviousBoot(input.db, input.bootId);
  const previousShutdown: PreviousShutdownKind =
    previousBoot === undefined
      ? "first_start"
      : previousBoot.cleanShutdownAt !== undefined
        ? "clean"
        : "unclean";

  recordBootStarted(input.db, input.bootId, input.startedAt);

  const taskSummary = reconcileTasks(input.taskStore, input.taskEventStore);

  let comparisonSummary = {
    comparisonsScanned: 0,
    interruptedPreparationsMarkedFailed: [] as readonly string[],
    interruptedCleanupsMarkedFailed: [] as readonly string[],
    eventProjectionsRepaired: 0,
    terminalOutcomesReplayed: 0,
    interruptedCandidateRunsMarkedFailed: [] as readonly string[],
  };
  let internalPaths: {
    readonly sourceRepositoryPaths: readonly {
      readonly comparisonId: string;
      readonly sourceRepositoryPath: string;
    }[];
    readonly worktreePaths: readonly {
      readonly candidateId: string;
      readonly comparisonId: string;
      readonly worktreePath: string;
    }[];
  } = { sourceRepositoryPaths: [], worktreePaths: [] };
  let worktreeHealthCounts = EMPTY_WORKTREE_HEALTH_COUNTS;
  let orphanWorktreeCount = 0;

  if (input.comparison !== undefined) {
    comparisonSummary = reconcileComparisons(
      input.comparison.comparisonStore,
      input.comparison.comparisonEventStore,
    );
    internalPaths = input.comparison.comparisonInternalPaths.listAll();

    const classifications = await classifyComparisonWorktrees({
      internalPaths: input.comparison.comparisonInternalPaths,
      comparisonStore: input.comparison.comparisonStore,
      gitWorktreeManager: input.comparison.gitWorktreeManager,
      interruptedCandidateIds: new Set(comparisonSummary.interruptedCandidateRunsMarkedFailed),
    });
    worktreeHealthCounts = { ...EMPTY_WORKTREE_HEALTH_COUNTS };
    for (const classification of classifications) {
      worktreeHealthCounts[classification.health] += 1;
    }
    orphanWorktreeCount = scanOrphanWorktrees({
      comparisonRoot: input.comparison.gitWorktreeManager.comparisonRoot,
      knownWorktreePaths: new Set(internalPaths.worktreePaths.map((entry) => entry.worktreePath)),
    });
  }

  const summary: RecoverySummary = {
    bootId: input.bootId,
    previousShutdown,
    tasksScanned: taskSummary.tasksScanned,
    taskEventProjectionsRepaired: taskSummary.eventProjectionsRepaired,
    taskTerminalOutcomesReplayed: taskSummary.terminalOutcomesReplayed,
    interruptedTaskRunCount: taskSummary.interruptedRunsMarkedFailed.length,
    comparisonsScanned: comparisonSummary.comparisonsScanned,
    interruptedPreparationCount: comparisonSummary.interruptedPreparationsMarkedFailed.length,
    interruptedCleanupCount: comparisonSummary.interruptedCleanupsMarkedFailed.length,
    comparisonEventProjectionsRepaired: comparisonSummary.eventProjectionsRepaired,
    comparisonTerminalOutcomesReplayed: comparisonSummary.terminalOutcomesReplayed,
    interruptedCandidateRunCount: comparisonSummary.interruptedCandidateRunsMarkedFailed.length,
    worktreeHealthCounts,
    orphanWorktreeCount,
  };

  recordRecoverySummary(input.db, input.bootId, JSON.stringify(summary));

  return {
    summary,
    internalPathsForRehydration: {
      sourceRepositoryPaths: internalPaths.sourceRepositoryPaths,
      worktreePaths: internalPaths.worktreePaths.map(({ candidateId, worktreePath }) => ({
        candidateId,
        worktreePath,
      })),
    },
  };
}
