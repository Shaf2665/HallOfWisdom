/**
 * Errors thrown while resolving a comparison's *source* Git repository from
 * its source task's stored working directory — a distinct concern from
 * `git-worktree-errors.ts` (which governs the comparison-root candidate
 * worktrees). Same layering convention: not `HallCoreError`-derived, safe to
 * log server-side, but never forwarded verbatim in an HTTP response — see
 * `ComparisonOrchestrator#describePreparationFailure`, which catches these
 * (by `instanceof`) and maps each to a stable, path-free `code`/`safeReason`
 * pair. See `docs/architecture/0012-controlled-agent-comparison.md`, "Source
 * repository resolution."
 */
export abstract class SourceRepositoryResolutionError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The source task has no working directory recorded at all — nothing to resolve a repository from. */
export class SourceWorkingDirectoryRequiredError extends SourceRepositoryResolutionError {
  constructor(taskId: string) {
    super(
      `Task "${taskId}" has no working directory set; comparisons require one to locate the source repository.`,
    );
  }
}
