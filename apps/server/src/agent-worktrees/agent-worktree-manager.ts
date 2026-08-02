import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AgentWorktreeGitOperationError,
  AgentWorktreePathError,
  AgentWorktreeSourceNotCleanError,
  boundSafeSummary,
} from "./agent-worktree-errors.js";
import type { AgentWorktreeStorePort } from "./agent-worktree-store-port.js";
import type { AgentWorktreeRecord } from "./agent-worktree-record.js";
import {
  assertGitSuccess,
  type GitCommandRunner,
  type GitCommandRunnerInput,
} from "./git-command-runner.js";
import {
  assertContainedPath,
  assertSafePathToken,
  canonicalizeExistingDirectory,
  canonicalizeOwnedRoot,
  isPathContained,
} from "./path-safety.js";

export interface AgentWorktreeManagerOptions {
  readonly store: AgentWorktreeStorePort;
  readonly gitRunner: GitCommandRunner;
  readonly ownedRoot: string;
  readonly gitTimeoutMs?: number | undefined;
  readonly now?: (() => string) | undefined;
  readonly idGenerator?: (() => string) | undefined;
}

export interface CreateAgentWorktreeInput {
  readonly hallTaskId: string;
  readonly hallAgentRunId: string;
  readonly sourceWorkingDirectory: string;
  readonly signal?: AbortSignal | undefined;
}

export interface CreateAgentWorktreeResult {
  readonly record: AgentWorktreeRecord;
  readonly agentWorkingDirectory: string;
}

export class AgentWorktreeManager {
  readonly #store: AgentWorktreeStorePort;
  readonly #gitRunner: GitCommandRunner;
  readonly #ownedRoot: string;
  readonly #gitTimeoutMs: number;
  readonly #now: () => string;
  readonly #idGenerator: () => string;

  constructor(options: AgentWorktreeManagerOptions) {
    this.#store = options.store;
    this.#gitRunner = options.gitRunner;
    this.#ownedRoot = options.ownedRoot;
    this.#gitTimeoutMs = options.gitTimeoutMs ?? 10_000;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async createWorktree(input: CreateAgentWorktreeInput): Promise<CreateAgentWorktreeResult> {
    const sourceWorkingDirectory = canonicalizeExistingDirectory(
      input.sourceWorkingDirectory,
      "source working directory",
    );
    const sourceRepositoryRoot = await this.#resolveRepositoryRoot(
      sourceWorkingDirectory,
      input.signal,
    );
    assertContainedPath({
      rootPath: sourceRepositoryRoot,
      candidatePath: sourceWorkingDirectory,
      description: "source working directory",
    });
    const ownedRoot = canonicalizeOwnedRoot({
      rawOwnedRoot: this.#ownedRoot,
      canonicalSourceRepositoryRoot: sourceRepositoryRoot,
    });
    await this.#assertSourceClean(sourceRepositoryRoot, input.signal);
    const baseCommit = await this.#resolveHeadCommit(sourceRepositoryRoot, input.signal);

    const worktreeId = this.#generateWorktreeId();
    const worktreeDirectoryName = `wt_${worktreeId}`;
    assertSafePathToken(worktreeDirectoryName, "worktree directory name");
    const intendedWorktreePath = path.join(ownedRoot, worktreeDirectoryName);
    assertContainedPath({
      rootPath: ownedRoot,
      candidatePath: intendedWorktreePath,
      description: "generated worktree path",
    });
    if (fs.existsSync(intendedWorktreePath)) {
      throw new AgentWorktreePathError("generated worktree path already exists.");
    }

    const relativeWorkingDirectory = toStoredRelativePath(
      path.relative(sourceRepositoryRoot, sourceWorkingDirectory),
    );
    const creating = this.#store.createCreating({
      worktreeId,
      hallTaskId: input.hallTaskId,
      hallAgentRunId: input.hallAgentRunId,
      canonicalSourceRepositoryRoot: sourceRepositoryRoot,
      sourceWorkingDirectoryRelativePath: relativeWorkingDirectory,
      baseCommit,
      canonicalWorktreePath: intendedWorktreePath,
      createdAt: this.#now(),
    });

    try {
      await this.#runGit(
        ["worktree", "add", "--detach", intendedWorktreePath, baseCommit],
        sourceRepositoryRoot,
        "GIT_WORKTREE_ADD_FAILED",
        input.signal,
      );
      const actualWorktreePath = canonicalizeExistingDirectory(
        intendedWorktreePath,
        "created worktree",
      );
      if (!samePath(actualWorktreePath, intendedWorktreePath)) {
        throw new AgentWorktreePathError("created worktree path did not canonicalize as expected.");
      }
      assertContainedPath({
        rootPath: ownedRoot,
        candidatePath: actualWorktreePath,
        description: "created worktree",
      });
      await this.#assertWorktreeRegistered(sourceRepositoryRoot, actualWorktreePath, input.signal);
      const actualHead = await this.#resolveHeadCommit(actualWorktreePath, input.signal);
      if (actualHead.toLowerCase() !== baseCommit.toLowerCase()) {
        throw new AgentWorktreeGitOperationError(
          "GIT_WORKTREE_HEAD_MISMATCH",
          "Created worktree HEAD did not match the resolved base commit.",
        );
      }
      await this.#assertDetachedHead(actualWorktreePath, input.signal);
      const agentWorkingDirectory = this.#resolveEquivalentWorkingDirectory(
        actualWorktreePath,
        relativeWorkingDirectory,
      );
      const ready = this.#store.markReady({
        worktreeId,
        expectedRevision: creating.revision,
        readyAt: this.#now(),
      });
      return { record: ready, agentWorkingDirectory };
    } catch (error) {
      const failure = toWorktreeFailure(error);
      this.#store.markCreationFailed({
        worktreeId,
        expectedRevision: creating.revision,
        safeFailureCode: failure.safeFailureCode,
        safeFailureSummary: failure.safeFailureSummary,
        now: this.#now(),
      });
      throw failure;
    }
  }

  async cleanupWorktree(worktreeId: string, signal?: AbortSignal): Promise<AgentWorktreeRecord> {
    const initial = this.#store.get(worktreeId);
    if (initial.status === "cleaned") return initial;
    const ownedRoot = canonicalizeOwnedRoot({
      rawOwnedRoot: this.#ownedRoot,
      canonicalSourceRepositoryRoot: initial.canonicalSourceRepositoryRoot,
    });
    assertContainedPath({
      rootPath: ownedRoot,
      candidatePath: initial.canonicalWorktreePath,
      description: "recorded worktree path",
    });
    const expectedPath = path.join(ownedRoot, `wt_${initial.worktreeId}`);
    if (!samePath(expectedPath, initial.canonicalWorktreePath)) {
      throw new AgentWorktreePathError("recorded worktree path does not match its worktree id.");
    }

    const pending =
      initial.status === "cleanup_pending"
        ? initial
        : this.#store.requestCleanup({
            worktreeId,
            expectedRevision: initial.revision,
            now: this.#now(),
          });

    const pathExists = fs.existsSync(pending.canonicalWorktreePath);
    const registered = await this.#isWorktreeRegistered(
      pending.canonicalSourceRepositoryRoot,
      pending.canonicalWorktreePath,
      signal,
    );
    if (!pathExists && !registered) {
      return this.#store.markCleaned({
        worktreeId,
        expectedRevision: pending.revision,
        now: this.#now(),
      });
    }

    try {
      await this.#runGit(
        ["worktree", "remove", "--force", pending.canonicalWorktreePath],
        pending.canonicalSourceRepositoryRoot,
        "GIT_WORKTREE_REMOVE_FAILED",
        signal,
      );
      return this.#store.markCleaned({
        worktreeId,
        expectedRevision: pending.revision,
        now: this.#now(),
      });
    } catch (error) {
      const failure = toWorktreeFailure(error);
      this.#store.markCleanupFailed({
        worktreeId,
        expectedRevision: pending.revision,
        safeFailureCode: failure.safeFailureCode,
        safeFailureSummary: failure.safeFailureSummary,
        now: this.#now(),
      });
      throw failure;
    }
  }

  async #resolveRepositoryRoot(cwd: string, signal: AbortSignal | undefined): Promise<string> {
    const stdout = await this.#runGit(
      ["rev-parse", "--show-toplevel"],
      cwd,
      "GIT_REPOSITORY_RESOLUTION_FAILED",
      signal,
    );
    return canonicalizeExistingDirectory(stdout.trim(), "source repository");
  }

  async #resolveHeadCommit(cwd: string, signal: AbortSignal | undefined): Promise<string> {
    const stdout = await this.#runGit(
      ["rev-parse", "--verify", "HEAD^{commit}"],
      cwd,
      "GIT_BASE_COMMIT_RESOLUTION_FAILED",
      signal,
    );
    const commit = stdout.trim();
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(commit)) {
      throw new AgentWorktreeGitOperationError(
        "GIT_BASE_COMMIT_INVALID",
        "Git returned an invalid commit object id.",
      );
    }
    return commit;
  }

  async #assertSourceClean(cwd: string, signal: AbortSignal | undefined): Promise<void> {
    const stdout = await this.#runGit(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd,
      "GIT_STATUS_FAILED",
      signal,
    );
    if (stdout.trim().length > 0) {
      throw new AgentWorktreeSourceNotCleanError();
    }
  }

  async #assertWorktreeRegistered(
    sourceRepositoryRoot: string,
    worktreePath: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!(await this.#isWorktreeRegistered(sourceRepositoryRoot, worktreePath, signal))) {
      throw new AgentWorktreeGitOperationError(
        "GIT_WORKTREE_NOT_REGISTERED",
        "Created worktree is not registered by Git.",
      );
    }
  }

  async #isWorktreeRegistered(
    sourceRepositoryRoot: string,
    worktreePath: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const stdout = await this.#runGit(
      ["worktree", "list", "--porcelain"],
      sourceRepositoryRoot,
      "GIT_WORKTREE_LIST_FAILED",
      signal,
    );
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .some((candidate) => samePath(path.resolve(candidate), worktreePath));
  }

  async #assertDetachedHead(worktreePath: string, signal: AbortSignal | undefined): Promise<void> {
    const result = await this.#gitRunner.run({
      args: ["symbolic-ref", "-q", "--short", "HEAD"],
      cwd: worktreePath,
      timeoutMs: this.#gitTimeoutMs,
      signal,
    });
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      throw new AgentWorktreeGitOperationError(
        "GIT_WORKTREE_NOT_DETACHED",
        "Created worktree unexpectedly has a branch checked out.",
      );
    }
    if (result.timedOut || result.spawnError !== undefined) {
      assertGitSuccess(result, "GIT_WORKTREE_DETACH_CHECK_FAILED");
    }
  }

  #resolveEquivalentWorkingDirectory(worktreePath: string, relativePath: string): string {
    const lexical = relativePath === "." ? worktreePath : path.join(worktreePath, relativePath);
    const canonical = canonicalizeExistingDirectory(lexical, "agent working directory");
    assertContainedPath({
      rootPath: worktreePath,
      candidatePath: canonical,
      description: "agent working directory",
    });
    return canonical;
  }

  async #runGit(
    args: GitCommandRunnerInput["args"],
    cwd: string,
    safeFailureCode: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const result = await this.#gitRunner.run({
      args,
      cwd,
      timeoutMs: this.#gitTimeoutMs,
      signal,
    });
    return assertGitSuccess(result, safeFailureCode);
  }

  #generateWorktreeId(): string {
    const raw = this.#idGenerator();
    assertSafePathToken(raw, "worktree id");
    return raw;
  }
}

function toStoredRelativePath(relativePath: string): string {
  if (relativePath === "") return ".";
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new AgentWorktreePathError(
      "source working directory must be inside the source repository.",
    );
  }
  return relativePath;
}

function toWorktreeFailure(error: unknown): AgentWorktreeGitOperationError {
  if (error instanceof AgentWorktreeGitOperationError) return error;
  if (error instanceof AgentWorktreeSourceNotCleanError) {
    return new AgentWorktreeGitOperationError("SOURCE_REPOSITORY_NOT_CLEAN", error.message);
  }
  if (error instanceof AgentWorktreePathError) {
    return new AgentWorktreeGitOperationError("AGENT_WORKTREE_PATH_INVALID", error.message);
  }
  return new AgentWorktreeGitOperationError(
    "AGENT_WORKTREE_UNEXPECTED_FAILURE",
    boundSafeSummary(error instanceof Error ? error.message : "Unexpected worktree failure."),
  );
}

function samePath(a: string, b: string): boolean {
  return isPathContained(a, b) && isPathContained(b, a);
}
