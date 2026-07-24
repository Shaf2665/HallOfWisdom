/**
 * Local error hierarchy for the Git worktree layer — deliberately not
 * `HallCoreError`-derived (same layering `@hall-of-wisdom/hall-runner`'s
 * `RunnerError` hierarchy uses relative to `apps/server`): this module has
 * no knowledge of HTTP status codes or the route layer. A higher-level
 * comparison orchestrator catches these and rewraps them into
 * `HallCoreError` subclasses for HTTP responses, exactly like
 * `TaskOrchestrator#resolveWorkingDirectory` rewraps `RunnerError`.
 *
 * Every message here is safe to log server-side but deliberately never
 * embeds raw `git` stderr beyond a short, bounded snippet — see
 * `GitCommandFailedError`.
 */
export abstract class GitWorktreeError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

const MAX_STDERR_SNIPPET_CHARS = 500;

function boundedSnippet(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_STDERR_SNIPPET_CHARS
    ? `${trimmed.slice(0, MAX_STDERR_SNIPPET_CHARS)}…`
    : trimmed;
}

/** A `git` invocation exited non-zero, timed out, or failed to spawn. */
export class GitCommandFailedError extends GitWorktreeError {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;

  constructor(
    args: readonly string[],
    detail: {
      exitCode: number | null;
      stderr: string;
      timedOut: boolean;
      spawnError?: string | undefined;
    },
  ) {
    const reason = detail.spawnError
      ? `spawn error: ${boundedSnippet(detail.spawnError)}`
      : detail.timedOut
        ? "timed out"
        : `exit code ${String(detail.exitCode)}: ${boundedSnippet(detail.stderr)}`;
    super(`git ${args.join(" ")} failed (${reason}).`);
    this.args = args;
    this.exitCode = detail.exitCode;
    this.timedOut = detail.timedOut;
  }
}

/** `git status --porcelain` reported uncommitted changes for a repository that must be clean before comparison. */
export class SourceRepositoryNotCleanError extends GitWorktreeError {
  constructor(repositoryPath: string) {
    super(
      `Repository at "${repositoryPath}" has uncommitted changes; comparisons require a clean working tree.`,
    );
  }
}

/** `repositoryPath` is not inside a Git repository (`git rev-parse --show-toplevel` failed). */
export class NotAGitRepositoryError extends GitWorktreeError {
  constructor(repositoryPath: string) {
    super(`"${repositoryPath}" is not inside a Git repository.`);
  }
}

/**
 * The intended worktree path (derived from a server-generated identifier)
 * would not be lexically contained within the configured comparison root,
 * or — post-creation — its canonicalized (symlink-resolved) real path
 * escaped the comparison root. Either case means a worktree is never
 * created/used; this is a hard stop, not a warning.
 */
export class WorktreeContainmentViolationError extends GitWorktreeError {
  constructor(worktreePath: string, comparisonRoot: string) {
    super(
      `Worktree path "${worktreePath}" is not contained within comparison root "${comparisonRoot}".`,
    );
  }
}

/** The worktree identifier supplied by the caller was not a safe, bounded, path-separator-free token. */
export class InvalidWorktreeIdentifierError extends GitWorktreeError {
  constructor(worktreeId: string) {
    super(`Worktree identifier "${worktreeId}" is not a valid safe identifier.`);
  }
}

/** A worktree already exists at the intended path — should be unreachable given unique server-generated identifiers. */
export class WorktreeAlreadyExistsError extends GitWorktreeError {
  constructor(worktreePath: string) {
    super(`A worktree already exists at "${worktreePath}".`);
  }
}

/**
 * `git worktree add` succeeded but the resulting worktree's `HEAD` does
 * not match the requested `baseCommit` exactly — defense-in-depth against
 * unexpected `git` behavior (e.g. a base ref that resolves differently
 * than expected). The worktree this error is thrown for is never used and
 * is removed by the caller before this error propagates.
 */
export class WorktreeCommitMismatchError extends GitWorktreeError {
  constructor(worktreePath: string, expected: string, actual: string) {
    super(
      `Worktree "${worktreePath}" HEAD "${actual}" does not match requested base commit "${expected}".`,
    );
  }
}

/** Attempted to remove a worktree path that is not contained within the configured comparison root — refused unconditionally. */
export class WorktreeRemovalRefusedError extends GitWorktreeError {
  constructor(worktreePath: string, comparisonRoot: string) {
    super(
      `Refusing to remove "${worktreePath}": not contained within comparison root "${comparisonRoot}".`,
    );
  }
}
