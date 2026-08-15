import { TextDecoder } from "node:util";
import type { AgentExecutionArtifactDiffSummary } from "../execution-artifacts/agent-execution-artifact-record.js";
import {
  compareArtifactStrings,
  normalizeChangedPath,
} from "../execution-artifacts/agent-execution-artifact-record.js";
import type { ValidatedAgentWorktreeHandle } from "../agent-worktrees/agent-worktree-manager.js";
import {
  assertGitSuccess,
  type GitCommandResult,
  type GitCommandRunner,
} from "../agent-worktrees/git-command-runner.js";
import { GitArtifactCollectionError } from "./agent-execution-errors.js";
import { HALL_ATTACHMENTS_DIRNAME } from "./task-attachment-materializer.js";

export interface GitArtifactCollectorOptions {
  readonly gitRunner: GitCommandRunner;
  readonly worktreeValidator?: GitArtifactWorktreeValidator | undefined;
  readonly gitTimeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface GitArtifactWorktreeValidator {
  validateReadyWorktree(input: {
    readonly worktreeId: string;
    readonly requireHeadAtBase?: boolean | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ValidatedAgentWorktreeHandle>;
}

export interface GitArtifactEvidence {
  readonly worktreeId: string;
  readonly hallTaskId: string;
  readonly hallAgentRunId: string;
  readonly baseCommit: string;
  readonly finalCommit: string;
  readonly changedFiles: readonly string[];
  readonly diffSummary: AgentExecutionArtifactDiffSummary;
}

export class GitArtifactCollector {
  readonly #gitRunner: GitCommandRunner;
  readonly #worktreeValidator: GitArtifactWorktreeValidator;
  readonly #gitTimeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: GitArtifactCollectorOptions) {
    if (options.worktreeValidator === undefined) {
      throw new GitArtifactCollectionError("A strong worktree validator is required.");
    }
    this.#gitRunner = options.gitRunner;
    this.#worktreeValidator = options.worktreeValidator;
    this.#gitTimeoutMs = options.gitTimeoutMs ?? 10_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 200_000;
  }

  async collect(worktreeId: string, signal?: AbortSignal): Promise<GitArtifactEvidence> {
    const handle = await this.#validatedReadyWorktree(worktreeId, signal);
    const record = handle.record;
    const worktreePath = handle.canonicalWorktreePath;
    const finalCommit = (
      await this.#runGitText(["rev-parse", "--verify", "HEAD^{commit}"], worktreePath, signal)
    ).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(finalCommit)) {
      throw new GitArtifactCollectionError("Git returned an invalid final commit.");
    }

    const trackedPaths = parseNulPaths(
      await this.#runGitBytes(
        [
          "diff",
          "--name-only",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          record.baseCommit,
          "--",
        ],
        worktreePath,
        signal,
      ),
    );
    const untrackedPaths = parseNulPaths(
      await this.#runGitBytes(
        ["ls-files", "--others", "--exclude-standard", "-z", "--"],
        worktreePath,
        signal,
      ),
    ).filter((filePath) => !isHallAttachmentsPath(filePath));
    const numstat = parseNumstat(
      await this.#runGitBytes(
        [
          "diff",
          "--numstat",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          record.baseCommit,
          "--",
        ],
        worktreePath,
        signal,
      ),
    );

    let insertions = 0;
    let deletions = 0;
    for (const entry of numstat.values()) {
      insertions = boundedAdd(insertions, entry.insertions);
      deletions = boundedAdd(deletions, entry.deletions);
    }
    const normalized = new Set<string>();
    for (const file of [...trackedPaths, ...untrackedPaths, ...numstat.keys()]) {
      normalized.add(
        normalizeChangedPath(file, (message) => new GitArtifactCollectionError(message)),
      );
    }
    const changedFiles = [...normalized].sort(compareArtifactStrings);
    return {
      worktreeId: record.worktreeId,
      hallTaskId: record.hallTaskId,
      hallAgentRunId: record.hallAgentRunId,
      baseCommit: record.baseCommit,
      finalCommit: finalCommit.toLowerCase(),
      changedFiles,
      diffSummary: {
        filesChanged: changedFiles.length,
        insertions,
        deletions,
      },
    };
  }

  async #validatedReadyWorktree(
    worktreeId: string,
    signal: AbortSignal | undefined,
  ): Promise<ValidatedAgentWorktreeHandle> {
    return this.#worktreeValidator.validateReadyWorktree({
      worktreeId,
      requireHeadAtBase: false,
      signal,
    });
  }

  async #runGitText(
    args: readonly string[],
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const result = await this.#runGitResult(args, cwd, signal);
    return assertGitSuccess(result, "GIT_ARTIFACT_COLLECTION_FAILED");
  }

  async #runGitBytes(
    args: readonly string[],
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<Buffer> {
    const result = await this.#runGitResult(args, cwd, signal);
    assertGitSuccess(result, "GIT_ARTIFACT_COLLECTION_FAILED");
    return result.stdoutBytes ?? Buffer.from(result.stdout, "utf8");
  }

  async #runGitResult(
    args: readonly string[],
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<GitCommandResult> {
    const result = await this.#gitRunner.run({
      args: ["-c", "core.fsmonitor=false", ...args],
      cwd,
      timeoutMs: this.#gitTimeoutMs,
      maxOutputChars: this.#maxOutputBytes,
      signal,
    });
    if (result.stdoutTruncated || result.stderrTruncated) {
      throw new GitArtifactCollectionError("Git artifact output exceeded the configured bound.");
    }
    return result;
  }
}

interface NumstatEntry {
  readonly insertions: number;
  readonly deletions: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeGitUtf8(bytes: Buffer): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new GitArtifactCollectionError("Git output was not valid UTF-8.");
  }
}

function parseNulPaths(bytes: Buffer): readonly string[] {
  if (bytes.length === 0) return [];
  const text = decodeGitUtf8(bytes);
  if (!text.endsWith("\0")) {
    throw new GitArtifactCollectionError("Git path output was not NUL-terminated.");
  }
  const entries = text.slice(0, -1).split("\0");
  if (entries.some((entry) => entry.length === 0)) {
    throw new GitArtifactCollectionError("Git path output contained an empty path.");
  }
  return entries;
}

function parseNumstat(bytes: Buffer): ReadonlyMap<string, NumstatEntry> {
  if (bytes.length === 0) return new Map();
  const rows = parseNulPaths(bytes);
  const parsed = new Map<string, NumstatEntry>();
  for (const row of rows) {
    const [rawInsertions, rawDeletions, filePath, extra] = row.split("\t");
    if (
      rawInsertions === undefined ||
      rawDeletions === undefined ||
      filePath === undefined ||
      extra !== undefined
    ) {
      throw new GitArtifactCollectionError("Git numstat output was malformed.");
    }
    if (parsed.has(filePath)) {
      throw new GitArtifactCollectionError("Git numstat output contained duplicate paths.");
    }
    parsed.set(filePath, {
      insertions: parseNumstatCounter(rawInsertions),
      deletions: parseNumstatCounter(rawDeletions),
    });
  }
  return parsed;
}

function parseNumstatCounter(value: string): number {
  if (value === "-") return 0;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new GitArtifactCollectionError("Git numstat counter was malformed.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new GitArtifactCollectionError("Git numstat counter exceeded safe integer range.");
  }
  return parsed;
}

/**
 * Materialized attachments (`HALL_ATTACHMENTS_DIRNAME`, written by
 * `TaskAttachmentMaterializer` before an agent runs) are Hall-injected
 * input, never agent output — `git ls-files --others` would otherwise
 * report every one of them as an untracked "change" this collector never
 * intended to describe. `git` always reports forward-slash paths, on every
 * platform, so a plain string prefix check is sufficient here.
 */
function isHallAttachmentsPath(filePath: string): boolean {
  return filePath === HALL_ATTACHMENTS_DIRNAME || filePath.startsWith(`${HALL_ATTACHMENTS_DIRNAME}/`);
}

function boundedAdd(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) {
    throw new GitArtifactCollectionError("Git numstat counter exceeded safe integer range.");
  }
  return result;
}
