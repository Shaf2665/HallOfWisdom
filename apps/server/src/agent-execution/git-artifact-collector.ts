import { TextDecoder } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { AgentExecutionArtifactDiffSummary } from "../execution-artifacts/agent-execution-artifact-record.js";
import {
  compareArtifactStrings,
  normalizeChangedPath,
} from "../execution-artifacts/agent-execution-artifact-record.js";
import type { AgentWorktreeRecord } from "../agent-worktrees/agent-worktree-record.js";
import type { AgentWorktreeStorePort } from "../agent-worktrees/agent-worktree-store-port.js";
import {
  assertGitSuccess,
  type GitCommandResult,
  type GitCommandRunner,
} from "../agent-worktrees/git-command-runner.js";
import {
  assertContainedPath,
  canonicalizeExistingDirectory,
  samePath,
} from "../agent-worktrees/path-safety.js";
import { GitArtifactCollectionError } from "./agent-execution-errors.js";

export interface GitArtifactCollectorOptions {
  readonly worktreeStore: AgentWorktreeStorePort;
  readonly gitRunner: GitCommandRunner;
  readonly ownedRoot: string;
  readonly gitTimeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
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
  readonly #worktreeStore: AgentWorktreeStorePort;
  readonly #gitRunner: GitCommandRunner;
  readonly #ownedRoot: string;
  readonly #gitTimeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: GitArtifactCollectorOptions) {
    this.#worktreeStore = options.worktreeStore;
    this.#gitRunner = options.gitRunner;
    this.#ownedRoot = options.ownedRoot;
    this.#gitTimeoutMs = options.gitTimeoutMs ?? 10_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 200_000;
  }

  async collect(worktreeId: string, signal?: AbortSignal): Promise<GitArtifactEvidence> {
    const record = this.#worktreeStore.get(worktreeId);
    const worktreePath = this.#validatedReadyWorktreePath(record);
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
    );
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

  #validatedReadyWorktreePath(record: AgentWorktreeRecord): string {
    if (record.status !== "ready") {
      throw new GitArtifactCollectionError("Worktree is not ready for artifact collection.");
    }
    const ownedRoot = canonicalizeExistingDirectory(this.#ownedRoot, "Hall-owned worktree root");
    const worktreePath = canonicalizeExistingDirectory(record.canonicalWorktreePath, "worktree");
    if (!samePath(worktreePath, record.canonicalWorktreePath)) {
      throw new GitArtifactCollectionError("Worktree path is not canonical.");
    }
    try {
      assertContainedPath({
        rootPath: ownedRoot,
        candidatePath: worktreePath,
        description: "worktree",
      });
    } catch {
      throw new GitArtifactCollectionError("Worktree path is outside the Hall-owned root.");
    }
    const stats = fs.lstatSync(worktreePath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new GitArtifactCollectionError("Worktree path is not a safe directory.");
    }
    assertContainedPath({
      rootPath: worktreePath,
      candidatePath: path.join(worktreePath, ".git"),
      description: "worktree Git metadata",
    });
    return worktreePath;
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

function boundedAdd(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) {
    throw new GitArtifactCollectionError("Git numstat counter exceeded safe integer range.");
  }
  return result;
}
