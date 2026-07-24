import path from "node:path";
import { validateWorkspace } from "@hall-of-wisdom/hall-runner";
import type { GitWorktreeManager } from "./git-worktree-manager.js";
import { SourceWorkingDirectoryRequiredError } from "./source-repository-errors.js";

export interface ResolveSourceRepositoryRootOptions {
  /** Canonical, already-validated workspace root — the trusted security boundary. May contain multiple repositories and need not itself be a Git repository or be clean. */
  readonly workspaceRoot: string;
  /** The source task's raw, schema-validated (relative, never-absolute) working directory, as stored by `TaskStore.getWorkingDirectory` — `undefined` if the task never had one set. */
  readonly rawWorkingDirectory: string | undefined;
  readonly gitWorktreeManager: GitWorktreeManager;
  /** Used only to build a safe, non-path error message. */
  readonly sourceTaskId: string;
}

/**
 * Resolves the actual Git repository a comparison must prepare against,
 * from its source task's own stored working directory — never from
 * `workspaceRoot` directly, which is a trusted *security boundary*, not a
 * repository. See `docs/architecture/0012-controlled-agent-comparison.md`,
 * "Source repository resolution," for the full policy this implements:
 *
 * 1. The task must have a working directory recorded at all.
 * 2. It is resolved (relative to `workspaceRoot`) and canonicalized
 *    (symlink/junction-resolved) via the same `validateWorkspace` helper
 *    `TaskOrchestrator` already uses for task execution — rejecting a
 *    directory that does not exist, is not a directory, or escapes
 *    `workspaceRoot` (including via a symlink that resolves outside it).
 * 3. `git rev-parse --show-toplevel` is run against that canonical
 *    directory (via `GitWorktreeManager.resolveRepositoryRoot`, already
 *    canonicalized) to find the actual repository root — which may be an
 *    ancestor of the task's working directory, or the working directory
 *    itself.
 * 4. The resolved repository root is re-validated against `workspaceRoot`
 *    (a second, independent `validateWorkspace` call) — defense in depth
 *    against a repository whose real top-level somehow resolves outside
 *    the workspace boundary (e.g. an unusual `.git`-file `gitdir:`
 *    indirection), even though the task's own working directory already
 *    passed the same check.
 *
 * Every failure here is a `SourceRepositoryResolutionError` or a
 * `RunnerError`/`GitWorktreeError` subtype — never thrown as a raw
 * filesystem or Git error, and never containing anything the caller cannot
 * safely rewrap into a bounded, path-free message (see
 * `ComparisonOrchestrator#describePreparationFailure`).
 */
export async function resolveSourceRepositoryRoot(
  options: ResolveSourceRepositoryRootOptions,
): Promise<string> {
  if (options.rawWorkingDirectory === undefined) {
    throw new SourceWorkingDirectoryRequiredError(options.sourceTaskId);
  }

  const resolvedTaskDirectory = path.resolve(options.workspaceRoot, options.rawWorkingDirectory);
  const { workingDirectory: canonicalTaskDirectory } = validateWorkspace({
    workspaceRoot: options.workspaceRoot,
    workingDirectory: resolvedTaskDirectory,
  });

  const repositoryRoot =
    await options.gitWorktreeManager.resolveRepositoryRoot(canonicalTaskDirectory);

  const { workingDirectory: canonicalRepositoryRoot } = validateWorkspace({
    workspaceRoot: options.workspaceRoot,
    workingDirectory: repositoryRoot,
  });

  return canonicalRepositoryRoot;
}
