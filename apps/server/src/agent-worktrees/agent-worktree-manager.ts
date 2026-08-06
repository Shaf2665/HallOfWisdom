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
  type GitCommandResult,
} from "./git-command-runner.js";
import {
  assertContainedPath,
  assertSafePathToken,
  canonicalizeExistingDirectory,
  canonicalizeOwnedRoot,
  samePath,
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
  /** Phase 16.5 — captured immutably on the created record; see `AgentWorktreeRecord.adapterId`'s doc comment. */
  readonly adapterId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly sourceWorkingDirectory: string;
  readonly signal?: AbortSignal | undefined;
}

export interface CreateAgentWorktreeResult {
  readonly record: AgentWorktreeRecord;
  readonly agentWorkingDirectory: string;
}

export interface ValidateReadyAgentWorktreeInput {
  readonly worktreeId: string;
  readonly hallTaskId?: string | undefined;
  readonly hallAgentRunId?: string | undefined;
  readonly sourceWorkingDirectory?: string | undefined;
  readonly requireHeadAtBase?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ValidatedAgentWorktreeHandle {
  readonly record: AgentWorktreeRecord;
  readonly canonicalOwnedRoot: string;
  readonly canonicalWorktreePath: string;
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
      ...(input.adapterId !== undefined ? { adapterId: input.adapterId } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      canonicalSourceRepositoryRoot: sourceRepositoryRoot,
      sourceWorkingDirectoryRelativePath: relativeWorkingDirectory,
      baseCommit,
      canonicalWorktreePath: intendedWorktreePath,
      createdAt: this.#now(),
    });

    try {
      await this.#runGit(
        ["worktree", "add", "--detach", "--no-checkout", intendedWorktreePath, baseCommit],
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
      await this.#assertNoExternalCheckoutFilters(actualWorktreePath, input.signal);
      const hooksDirectory = canonicalizeEmptyHooksDirectory(ownedRoot);
      await this.#runGit(
        ["-c", `core.hooksPath=${hooksDirectory}`, "checkout", "--detach", "--force", baseCommit],
        actualWorktreePath,
        "GIT_WORKTREE_CHECKOUT_FAILED",
        input.signal,
      );
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
    this.#validateCleanupTarget(initial, ownedRoot);

    const pending =
      initial.status === "cleanup_pending"
        ? initial
        : this.#store.requestCleanup({
            worktreeId,
            expectedRevision: initial.revision,
            now: this.#now(),
          });

    const checked = this.#validateCleanupTarget(pending, ownedRoot);
    const registered = await this.#isWorktreeRegistered(
      pending.canonicalSourceRepositoryRoot,
      checked.expectedPath,
      signal,
    );
    if (!checked.pathExists && !registered) {
      return this.#store.markCleaned({
        worktreeId,
        expectedRevision: pending.revision,
        now: this.#now(),
      });
    }

    try {
      const beforeRemoval = this.#validateCleanupTarget(pending, ownedRoot);
      await this.#runGit(
        ["worktree", "remove", "--force", beforeRemoval.expectedPath],
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

  async validateReadyWorktree(
    input: ValidateReadyAgentWorktreeInput,
  ): Promise<ValidatedAgentWorktreeHandle> {
    assertSafePathToken(input.worktreeId, "worktree id");
    const record = this.#store.get(input.worktreeId);
    if (record.status !== "ready") {
      throw new AgentWorktreePathError("worktree is not ready.");
    }
    if (
      (input.hallTaskId !== undefined && record.hallTaskId !== input.hallTaskId) ||
      (input.hallAgentRunId !== undefined && record.hallAgentRunId !== input.hallAgentRunId)
    ) {
      throw new AgentWorktreePathError("worktree record does not match the requested run.");
    }
    const ownedRoot = canonicalizeOwnedRoot({
      rawOwnedRoot: this.#ownedRoot,
      canonicalSourceRepositoryRoot: record.canonicalSourceRepositoryRoot,
    });
    const checked = this.#validateCleanupTarget(record, ownedRoot);
    if (!checked.pathExists) {
      throw new AgentWorktreePathError("worktree path is missing.");
    }
    const worktreePath = checked.expectedPath;
    await this.#assertWorktreeRegistered(
      record.canonicalSourceRepositoryRoot,
      worktreePath,
      input.signal,
    );
    const topLevel = canonicalizeExistingDirectory(
      (
        await this.#runGit(
          ["rev-parse", "--show-toplevel"],
          worktreePath,
          "GIT_WORKTREE_TOPLEVEL_FAILED",
          input.signal,
        )
      ).trim(),
      "worktree top-level",
    );
    if (!samePath(topLevel, worktreePath)) {
      throw new AgentWorktreePathError("worktree top-level does not match the recorded path.");
    }
    const commonDir = await this.#resolveGitCommonDirectory(worktreePath, input.signal);
    const sourceCommonDir = await this.#resolveGitCommonDirectory(
      record.canonicalSourceRepositoryRoot,
      input.signal,
    );
    if (!samePath(commonDir, sourceCommonDir)) {
      throw new AgentWorktreePathError("worktree Git common directory does not match the source.");
    }
    if (input.requireHeadAtBase === true) {
      const actualHead = await this.#resolveHeadCommit(worktreePath, input.signal);
      if (actualHead.toLowerCase() !== record.baseCommit.toLowerCase()) {
        throw new AgentWorktreeGitOperationError(
          "GIT_WORKTREE_HEAD_MISMATCH",
          "Worktree HEAD did not match the recorded base commit.",
        );
      }
      await this.#assertDetachedHead(worktreePath, input.signal);
    }
    if (input.sourceWorkingDirectory !== undefined) {
      const sourceWorkingDirectory = canonicalizeExistingDirectory(
        input.sourceWorkingDirectory,
        "source working directory",
      );
      const expectedSourceDirectory =
        record.sourceWorkingDirectoryRelativePath === "."
          ? record.canonicalSourceRepositoryRoot
          : path.join(
              record.canonicalSourceRepositoryRoot,
              record.sourceWorkingDirectoryRelativePath,
            );
      const canonicalExpectedSource = canonicalizeExistingDirectory(
        expectedSourceDirectory,
        "recorded source working directory",
      );
      if (!samePath(canonicalExpectedSource, sourceWorkingDirectory)) {
        throw new AgentWorktreePathError("worktree source directory does not match.");
      }
    }
    const agentWorkingDirectory = this.#resolveEquivalentWorkingDirectory(
      worktreePath,
      record.sourceWorkingDirectoryRelativePath,
    );
    return {
      record,
      canonicalOwnedRoot: ownedRoot,
      canonicalWorktreePath: worktreePath,
      agentWorkingDirectory,
    };
  }

  #validateCleanupTarget(
    record: AgentWorktreeRecord,
    ownedRoot: string,
  ): { readonly expectedPath: string; readonly pathExists: boolean } {
    assertSafePathToken(record.worktreeId, "worktree id");
    const expectedDirectoryName = `wt_${record.worktreeId}`;
    assertSafePathToken(expectedDirectoryName, "worktree directory name");
    const expectedPath = path.join(ownedRoot, expectedDirectoryName);
    assertContainedPath({
      rootPath: ownedRoot,
      candidatePath: expectedPath,
      description: "expected worktree path",
    });
    if (!samePath(expectedPath, record.canonicalWorktreePath)) {
      throw new AgentWorktreePathError("recorded worktree path does not match its worktree id.");
    }
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(expectedPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return { expectedPath, pathExists: false };
      }
      throw new AgentWorktreePathError("recorded worktree path could not be inspected.");
    }
    if (stats.isSymbolicLink()) {
      throw new AgentWorktreePathError(
        "recorded worktree path must not be a symbolic link or junction.",
      );
    }
    if (!stats.isDirectory()) {
      throw new AgentWorktreePathError("recorded worktree path must be a directory.");
    }

    let canonicalTarget: string;
    try {
      canonicalTarget = fs.realpathSync.native(expectedPath);
    } catch {
      throw new AgentWorktreePathError("recorded worktree path could not be canonicalized.");
    }
    if (!samePath(canonicalTarget, expectedPath)) {
      throw new AgentWorktreePathError("recorded worktree path resolved outside its safe target.");
    }
    assertContainedPath({
      rootPath: ownedRoot,
      candidatePath: canonicalTarget,
      description: "recorded worktree path",
    });
    return { expectedPath, pathExists: true };
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

  async #assertNoExternalCheckoutFilters(
    worktreePath: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const result = await this.#runGitResult(
      ["config", "--name-only", "--get-regexp", "^filter\\..*\\."],
      worktreePath,
      signal,
    );
    if (result.exitCode === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") {
      return;
    }
    if (result.exitCode !== 0 || result.timedOut || result.spawnError !== undefined) {
      assertGitSuccess(result, "GIT_FILTER_CONFIG_INSPECTION_FAILED");
    }
    const unsupportedFilterKeys = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /\.(clean|smudge|process)$/i.test(line));
    if (unsupportedFilterKeys.length > 0) {
      throw new AgentWorktreeGitOperationError(
        "GIT_CHECKOUT_FILTER_UNSUPPORTED",
        "Git checkout filters are not supported for agent worktrees.",
      );
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
    return parseWorktreeListPorcelain(stdout).some((candidate) =>
      samePath(candidate, worktreePath),
    );
  }

  /**
   * Phase 16.5 — read-only registration inspection for restart
   * reconciliation's orphan/reappearance detection. Returns every path
   * Git currently has registered against `sourceRepositoryRoot`, including
   * the primary checkout itself and any worktree registered anywhere
   * (comparison worktrees included) — the caller is responsible for
   * filtering to paths under its own owned root before drawing any
   * conclusion; this method never does. Never mutates anything. Truncated
   * output fails closed (throws) rather than silently returning a partial
   * list a caller could mistake for the complete registration set.
   */
  async listRegisteredWorktreePaths(
    sourceRepositoryRoot: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const result = await this.#runGitResult(
      ["worktree", "list", "--porcelain"],
      sourceRepositoryRoot,
      signal,
    );
    if (result.stdoutTruncated === true) {
      throw new AgentWorktreeGitOperationError(
        "GIT_WORKTREE_LIST_TRUNCATED",
        "Git worktree list output was truncated.",
      );
    }
    const stdout = assertGitSuccess(result, "GIT_WORKTREE_LIST_FAILED");
    return parseWorktreeListPorcelain(stdout);
  }

  async #assertDetachedHead(worktreePath: string, signal: AbortSignal | undefined): Promise<void> {
    const result = await this.#runGitResult(
      ["symbolic-ref", "-q", "--short", "HEAD"],
      worktreePath,
      signal,
    );
    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      throw new AgentWorktreeGitOperationError(
        "GIT_WORKTREE_NOT_DETACHED",
        "Created worktree unexpectedly has a branch checked out.",
      );
    }
    if (result.timedOut || result.spawnError !== undefined) {
      assertGitSuccess(result, "GIT_WORKTREE_DETACH_CHECK_FAILED");
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      assertGitSuccess(result, "GIT_WORKTREE_DETACH_CHECK_FAILED");
    }
  }

  async #resolveGitCommonDirectory(cwd: string, signal: AbortSignal | undefined): Promise<string> {
    const stdout = await this.#runGit(
      ["rev-parse", "--git-common-dir"],
      cwd,
      "GIT_WORKTREE_COMMON_DIR_FAILED",
      signal,
    );
    const raw = stdout.trim();
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    return canonicalizeExistingDirectory(resolved, "Git common directory");
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
    const result = await this.#runGitResult(args, cwd, signal);
    return assertGitSuccess(result, safeFailureCode);
  }

  #runGitResult(
    args: GitCommandRunnerInput["args"],
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<GitCommandResult> {
    return this.#gitRunner.run({
      args: withManagerGitConfig(args),
      cwd,
      timeoutMs: this.#gitTimeoutMs,
      signal,
    });
  }

  #generateWorktreeId(): string {
    const raw = this.#idGenerator();
    assertSafePathToken(raw, "worktree id");
    return raw;
  }
}

function withManagerGitConfig(args: GitCommandRunnerInput["args"]): readonly string[] {
  return ["-c", "core.fsmonitor=false", ...args];
}

function canonicalizeEmptyHooksDirectory(ownedRoot: string): string {
  const hooksDirectory = path.join(ownedRoot, "_hall_empty_hooks");
  assertContainedPath({
    rootPath: ownedRoot,
    candidatePath: hooksDirectory,
    description: "Hall-controlled hooks directory",
  });
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(hooksDirectory);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw new AgentWorktreePathError("Hall-controlled hooks directory could not be inspected.");
    }
    fs.mkdirSync(hooksDirectory);
    try {
      stats = fs.lstatSync(hooksDirectory);
    } catch {
      throw new AgentWorktreePathError("Hall-controlled hooks directory could not be inspected.");
    }
  }
  if (stats.isSymbolicLink()) {
    throw new AgentWorktreePathError(
      "Hall-controlled hooks directory must not be a symbolic link or junction.",
    );
  }
  if (!stats.isDirectory()) {
    throw new AgentWorktreePathError("Hall-controlled hooks directory must be a directory.");
  }
  const canonicalHooksDirectory = canonicalizeExistingDirectory(
    hooksDirectory,
    "Hall-controlled hooks directory",
  );
  assertContainedPath({
    rootPath: ownedRoot,
    candidatePath: canonicalHooksDirectory,
    description: "Hall-controlled hooks directory",
  });
  if (fs.readdirSync(canonicalHooksDirectory).length > 0) {
    throw new AgentWorktreePathError("Hall-controlled hooks directory must be empty.");
  }
  return canonicalHooksDirectory;
}

function parseWorktreeListPorcelain(stdout: string): readonly string[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length).trim()));
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
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
