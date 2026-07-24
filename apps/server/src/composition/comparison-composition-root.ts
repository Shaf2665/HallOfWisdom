import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { ComparisonOrchestrator } from "../comparisons/comparison-orchestrator.js";
import { ComparisonStore } from "../comparisons/comparison-store.js";
import { GitWorktreeManager } from "../comparisons/git-worktree-manager.js";
import { nodeProcessSpawner } from "../comparisons/process-spawner.js";
import { EventStore } from "../events/event-store.js";
import { EventBus } from "../events/event-bus.js";
import type { TaskStore } from "../tasks/task-store.js";
import type { ServerLimits } from "../config/server-config.js";

export interface ComparisonCompositionOptions {
  readonly registry: AgentRegistry;
  readonly taskStore: TaskStore;
  /** Canonical, already-validated workspace root — the single source repository every comparison prepares against. */
  readonly workspaceRoot: string;
  /** Canonical, already-validated comparison-root — mutually non-contained with `workspaceRoot`; see `server.ts`. */
  readonly comparisonRoot: string;
  readonly limits: ServerLimits;
  readonly onExecutionError?: ((candidateId: string, error: unknown) => void) | undefined;
}

export interface ComparisonComposition {
  readonly comparisonStore: ComparisonStore;
  readonly comparisonEventStore: EventStore;
  readonly comparisonEventBus: EventBus;
  readonly comparisonOrchestrator: ComparisonOrchestrator;
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
  const comparisonStore = new ComparisonStore({ maxComparisons: options.limits.maxComparisons });
  const comparisonEventStore = new EventStore({
    maxEventsPerTask: options.limits.maxEventsPerComparisonCandidate,
  });
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
  });

  return { comparisonStore, comparisonEventStore, comparisonEventBus, comparisonOrchestrator };
}
