import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isContainedPath } from "@hall-of-wisdom/hall-runner";
import { runGitCommand } from "./git-command.js";
import type { ProcessSpawner } from "./process-spawner.js";
import {
  GitCommandFailedError,
  InvalidWorktreeIdentifierError,
  NotAGitRepositoryError,
  SourceRepositoryNotCleanError,
  WorktreeAlreadyExistsError,
  WorktreeCommitMismatchError,
  WorktreeContainmentViolationError,
  WorktreeRemovalRefusedError,
} from "./git-worktree-errors.js";

export interface GitWorktreeManagerOptions {
  readonly spawner: ProcessSpawner;
  /** Resolvable `git` executable — a bare `"git"` lets the OS resolve it via `PATH`; tests may inject an absolute fixture path. */
  readonly gitExecutablePath: string;
  readonly timeoutMs: number;
  /** Canonical (symlink-resolved), already-validated absolute path — see `server.ts` / `validateWorkspace`. Never nested inside, and never an ancestor of, the source workspace root — enforced at startup, not by this class. */
  readonly comparisonRoot: string;
}

export interface CreateWorktreeInput {
  /** Canonical absolute path to the source repository's root — see `resolveRepositoryRoot`. */
  readonly repositoryPath: string;
  /** Full 40-character commit SHA the worktree must be checked out at. */
  readonly baseCommit: string;
  /** Safe, server-generated identifier (never client-supplied) that becomes the worktree's directory name under the comparison root. */
  readonly worktreeId: string;
}

export interface CreatedWorktree {
  /** Canonical, containment-verified, commit-verified absolute path to the new worktree. */
  readonly worktreePath: string;
}

const WORKTREE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function defaultCaseSensitivity(platform: NodeJS.Platform = os.platform()): boolean {
  return platform !== "win32" && platform !== "darwin";
}

/**
 * The only component in Hall Core allowed to create, remove, or prune Git
 * worktrees for the multi-agent comparison feature (Phase 12). Every
 * mutating operation is scoped to a single configured `comparisonRoot`
 * and never creates a branch, commit, or remote reference — see
 * `docs/architecture/0012-controlled-agent-comparison.md`, "Git worktree
 * isolation".
 *
 * Path safety is two-phase, deliberately (see that doc's "Worktree path
 * safety" section for the full rationale): before a worktree exists, only
 * a *lexical* containment check against `comparisonRoot` is possible
 * (`#assertContained` on the intended path, built from a
 * regex-validated, server-generated identifier — never a client-supplied
 * path fragment). After `git worktree add` creates the directory, this
 * class re-resolves it via `fs.realpathSync.native` and re-checks
 * containment against the *canonicalized* path — closing the gap a
 * symlink or junction anywhere on the comparison-root path could
 * otherwise open, exactly like `@hall-of-wisdom/hall-runner`'s
 * `validateWorkspace` does for task working directories.
 */
export class GitWorktreeManager {
  readonly #spawner: ProcessSpawner;
  readonly #gitExecutablePath: string;
  readonly #timeoutMs: number;
  readonly #comparisonRoot: string;

  constructor(options: GitWorktreeManagerOptions) {
    this.#spawner = options.spawner;
    this.#gitExecutablePath = options.gitExecutablePath;
    this.#timeoutMs = options.timeoutMs;
    this.#comparisonRoot = options.comparisonRoot;
  }

  get comparisonRoot(): string {
    return this.#comparisonRoot;
  }

  /**
   * `git rev-parse --show-toplevel` — the canonical repository root for
   * any path inside a working tree (which may differ from the path
   * passed in, e.g. a subdirectory). Throws `NotAGitRepositoryError` if
   * `repositoryPath` is not inside a Git repository at all.
   */
  async resolveRepositoryRoot(repositoryPath: string): Promise<string> {
    const result = await this.#tryRunGit(["rev-parse", "--show-toplevel"], repositoryPath);
    if (result === undefined) {
      throw new NotAGitRepositoryError(repositoryPath);
    }
    // git always prints forward-slash paths even on Windows; realpath
    // both normalizes separators and resolves any symlink/junction.
    return fs.realpathSync.native(result.trim());
  }

  /** `git rev-parse HEAD` — the current commit SHA of `repositoryPath`, validated as a full 40-character hex SHA. */
  async resolveHeadCommit(repositoryPath: string): Promise<string> {
    const stdout = await this.#runGit(["rev-parse", "HEAD"], repositoryPath);
    const commit = stdout.trim();
    if (!FULL_COMMIT_SHA_PATTERN.test(commit)) {
      throw new GitCommandFailedError(["rev-parse", "HEAD"], {
        exitCode: 0,
        stderr: `unexpected output: "${commit}"`,
        timedOut: false,
      });
    }
    return commit;
  }

  /** Throws `SourceRepositoryNotCleanError` unless `git status --porcelain` reports no changes at all (staged, unstaged, or untracked). */
  async assertWorkingTreeClean(repositoryPath: string): Promise<void> {
    const stdout = await this.#runGit(["status", "--porcelain"], repositoryPath);
    if (stdout.trim().length > 0) {
      throw new SourceRepositoryNotCleanError(repositoryPath);
    }
  }

  /**
   * Creates one detached worktree at `<comparisonRoot>/<worktreeId>`,
   * checked out exactly at `baseCommit`. Atomic from the caller's
   * perspective: any failure after `git worktree add` succeeds (the
   * post-creation containment check or the commit-match check) triggers a
   * best-effort removal of the partially-created worktree before the
   * error propagates — no partially-prepared worktree is ever left for
   * the caller to see as a success.
   */
  async createWorktree(input: CreateWorktreeInput): Promise<CreatedWorktree> {
    if (!WORKTREE_ID_PATTERN.test(input.worktreeId)) {
      throw new InvalidWorktreeIdentifierError(input.worktreeId);
    }

    const intendedPath = path.join(this.#comparisonRoot, input.worktreeId);
    this.#assertContained(intendedPath);

    if (fs.existsSync(intendedPath)) {
      throw new WorktreeAlreadyExistsError(intendedPath);
    }

    await this.#runGit(
      ["worktree", "add", "--detach", intendedPath, input.baseCommit],
      input.repositoryPath,
    );

    try {
      const canonicalPath = fs.realpathSync.native(intendedPath);

      if (!this.#isContained(canonicalPath)) {
        throw new WorktreeContainmentViolationError(canonicalPath, this.#comparisonRoot);
      }

      const actualHead = await this.resolveHeadCommit(canonicalPath);
      if (actualHead.toLowerCase() !== input.baseCommit.toLowerCase()) {
        throw new WorktreeCommitMismatchError(canonicalPath, input.baseCommit, actualHead);
      }

      return { worktreePath: canonicalPath };
    } catch (error) {
      await this.#tryRunGit(["worktree", "remove", "--force", intendedPath], input.repositoryPath);
      throw error;
    }
  }

  /**
   * Removes a previously created worktree. `worktreePath` must be the
   * exact canonical path this manager returned from `createWorktree` —
   * callers (the comparison store/orchestrator) must record and pass back
   * that value verbatim, never a re-derived or request-supplied path —
   * see `docs/architecture/0012-controlled-agent-comparison.md`, "Cleanup
   * safety". Refuses (rather than silently no-oping) any path outside the
   * comparison root, as a last line of defense even if a caller violates
   * that contract. Uses `git worktree remove --force` rather than a raw
   * recursive delete: `git` itself refuses to remove the repository's
   * main worktree, which a raw `rm -rf` cannot distinguish.
   */
  async removeWorktree(repositoryPath: string, worktreePath: string): Promise<void> {
    if (!this.#isContained(worktreePath)) {
      throw new WorktreeRemovalRefusedError(worktreePath, this.#comparisonRoot);
    }
    await this.#runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
  }

  /** `git worktree prune` — clears stale worktree administrative metadata left behind after an out-of-band directory removal. Touches only `git`'s own bookkeeping, never a working-tree file. */
  async pruneWorktrees(repositoryPath: string): Promise<void> {
    await this.#runGit(["worktree", "prune"], repositoryPath);
  }

  #isContained(candidatePath: string): boolean {
    return isContainedPath(this.#comparisonRoot, candidatePath, {
      caseSensitive: defaultCaseSensitivity(),
      path,
    });
  }

  #assertContained(candidatePath: string): void {
    if (!this.#isContained(candidatePath)) {
      throw new WorktreeContainmentViolationError(candidatePath, this.#comparisonRoot);
    }
  }

  async #runGit(args: readonly string[], cwd: string): Promise<string> {
    return runGitCommand(args, cwd, {
      spawner: this.#spawner,
      gitExecutablePath: this.#gitExecutablePath,
      timeoutMs: this.#timeoutMs,
    });
  }

  /** Like `#runGit` but resolves `undefined` instead of throwing — used for the "is this even a Git repository" probe and for best-effort cleanup-on-rollback calls whose own failure must never mask the original error. */
  async #tryRunGit(args: readonly string[], cwd: string): Promise<string | undefined> {
    try {
      return await this.#runGit(args, cwd);
    } catch {
      return undefined;
    }
  }
}
