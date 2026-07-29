/**
 * Durable-mode-only persistence for the two absolute-filesystem-path facts
 * `ComparisonOrchestrator` otherwise keeps purely in its own private,
 * never-serialized `#sourceRepositoryPaths`/`#worktreePaths` maps (see that
 * class's doc comment). `ComparisonStorePort`/`SqliteComparisonStore`
 * deliberately know nothing about these paths — they are a wholly separate,
 * orchestrator-level concern, structurally kept out of the public comparison
 * record shape (`AgentComparisonRecord` has no path field) exactly as it is
 * in ephemeral mode.
 *
 * In ephemeral mode, `ComparisonOrchestrator` is never given an
 * implementation of this port at all — its private maps ARE the only
 * storage, unchanged. In durable mode, `SqliteComparisonInternalPaths` is
 * supplied so the same facts also survive a restart; `restart-recovery.ts`
 * reads `listAll()` at startup to rehydrate the orchestrator's in-memory
 * maps (see `ComparisonOrchestrator.rehydrateInternalPaths()`) and to
 * classify each candidate worktree's on-disk health.
 */
export interface ComparisonInternalPathsPort {
  setSourceRepositoryPath(comparisonId: string, sourceRepositoryPath: string): void;
  deleteSourceRepositoryPath(comparisonId: string): void;
  setWorktreePath(candidateId: string, comparisonId: string, worktreePath: string): void;
  deleteWorktreePath(candidateId: string): void;
  listAll(): {
    readonly sourceRepositoryPaths: readonly {
      readonly comparisonId: string;
      readonly sourceRepositoryPath: string;
    }[];
    readonly worktreePaths: readonly {
      readonly candidateId: string;
      readonly comparisonId: string;
      readonly worktreePath: string;
    }[];
  };
}
