import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { ComparisonOrchestrator } from "../comparisons/comparison-orchestrator.js";
import { ComparisonStore } from "../comparisons/comparison-store.js";
import { SqliteComparisonStore } from "../comparisons/sqlite-comparison-store.js";
import type { ComparisonStorePort } from "../comparisons/comparison-store-port.js";
import { SqliteComparisonInternalPaths } from "../comparisons/sqlite-comparison-internal-paths.js";
import type { ComparisonInternalPathsPort } from "../comparisons/comparison-internal-paths-port.js";
import { GitWorktreeManager } from "../comparisons/git-worktree-manager.js";
import { nodeProcessSpawner } from "../comparisons/process-spawner.js";
import { EventStore } from "../events/event-store.js";
import { SqliteEventStore } from "../events/sqlite-event-store.js";
import type { NormalizedEventStorePort } from "../events/event-store-port.js";
import { EventBus } from "../events/event-bus.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import type { ServerLimits } from "../config/server-config.js";
import type { HallDatabase } from "../persistence/database.js";

export interface ComparisonCompositionOptions {
  readonly registry: AgentRegistry;
  readonly taskStore: TaskStorePort;
  /** Canonical, already-validated workspace root — the single source repository every comparison prepares against. */
  readonly workspaceRoot: string;
  /** Canonical, already-validated comparison-root — mutually non-contained with `workspaceRoot`; see `server.ts`. */
  readonly comparisonRoot: string;
  readonly limits: ServerLimits;
  readonly onExecutionError?: ((candidateId: string, error: unknown) => void) | undefined;
  /**
   * Phase 13 — when supplied, `comparisonStore`/`comparisonEventStore`/
   * `comparisonInternalPaths` are the SQLite-backed durable siblings
   * instead of the in-memory ones, sharing this same connection with every
   * other durable-mode store — see `server-composition.ts`.
   */
  readonly db?: HallDatabase | undefined;
}

export interface ComparisonComposition {
  readonly comparisonStore: ComparisonStorePort;
  readonly comparisonEventStore: NormalizedEventStorePort;
  readonly comparisonEventBus: EventBus;
  readonly comparisonOrchestrator: ComparisonOrchestrator;
  readonly gitWorktreeManager: GitWorktreeManager;
  /** Present only in durable mode (`options.db` supplied) — see `ComparisonOrchestratorOptions.internalPaths`. */
  readonly comparisonInternalPaths?: ComparisonInternalPathsPort | undefined;
}

/**
 * The multi-agent comparison feature's own composition root (Phase 12) —
 * mirrors `mock-agent-composition-root.ts`'s shape, but this one is
 * entirely optional at the top level: `server.ts` only calls this when an
 * operator passes `--comparison-root`. `comparisonEventStore`/
 * `comparisonEventBus` are dedicated, fresh instances — never the task
 * ones `createMockAgentServerComposition` builds — so a comparison
 * candidate's event stream can never share a capacity budget with, or be
 * confused for, a real task's.
 */
export function createComparisonComposition(
  options: ComparisonCompositionOptions,
): ComparisonComposition {
  const db = options.db;

  const comparisonStore: ComparisonStorePort =
    db !== undefined
      ? new SqliteComparisonStore({ db, maxComparisons: options.limits.maxComparisons })
      : new ComparisonStore({ maxComparisons: options.limits.maxComparisons });

  const comparisonEventStore: NormalizedEventStorePort =
    db !== undefined
      ? new SqliteEventStore({
          db,
          streamKind: "comparison_candidate",
          maxEventsPerStream: options.limits.maxEventsPerComparisonCandidate,
        })
      : new EventStore({ maxEventsPerTask: options.limits.maxEventsPerComparisonCandidate });

  const comparisonInternalPaths: ComparisonInternalPathsPort | undefined =
    db !== undefined ? new SqliteComparisonInternalPaths({ db }) : undefined;

  const comparisonEventBus = new EventBus({
    maxSubscribersPerTask: options.limits.maxSubscribersPerComparisonCandidate,
  });

  const gitWorktreeManager = new GitWorktreeManager({
    spawner: nodeProcessSpawner,
    gitExecutablePath: "git",
    timeoutMs: options.limits.gitCommandTimeoutMs,
    comparisonRoot: options.comparisonRoot,
  });

  const comparisonOrchestrator = new ComparisonOrchestrator({
    comparisonStore,
    taskStore: options.taskStore,
    eventStore: comparisonEventStore,
    eventBus: comparisonEventBus,
    registry: options.registry,
    gitWorktreeManager,
    workspaceRoot: options.workspaceRoot,
    resultEvidenceOptions: {
      spawner: nodeProcessSpawner,
      gitExecutablePath: "git",
      timeoutMs: options.limits.gitCommandTimeoutMs,
      maxChangedFiles: options.limits.maxComparisonChangedFiles,
      maxDiffChars: options.limits.maxComparisonDiffChars,
    },
    cleanupGraceTimeoutMs: options.limits.comparisonCleanupGraceTimeoutMs,
    onExecutionError: options.onExecutionError,
    internalPaths: comparisonInternalPaths,
  });

  return {
    comparisonStore,
    comparisonEventStore,
    comparisonEventBus,
    comparisonOrchestrator,
    gitWorktreeManager,
    comparisonInternalPaths,
  };
}
