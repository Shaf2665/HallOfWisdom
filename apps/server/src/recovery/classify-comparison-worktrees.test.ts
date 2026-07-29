import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorktreeManager } from "../comparisons/git-worktree-manager.js";
import { nodeProcessSpawner } from "../comparisons/process-spawner.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { SqliteComparisonInternalPaths } from "../comparisons/sqlite-comparison-internal-paths.js";
import { SqliteComparisonStore } from "../comparisons/sqlite-comparison-store.js";
import type {
  AgentComparisonRecord,
  ComparisonCandidateRecord,
} from "../comparisons/comparison-record.js";
import {
  classifyComparisonWorktrees,
  scanOrphanWorktrees,
} from "./classify-comparison-worktrees.js";

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function initRepoWithCommit(repoPath: string): void {
  git(["init", "--quiet"], repoPath);
  git(["config", "user.email", "hall-of-wisdom-test@example.com"], repoPath);
  git(["config", "user.name", "Hall of Wisdom Test"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "hello\n");
  git(["add", "README.md"], repoPath);
  git(["commit", "--quiet", "-m", "initial commit"], repoPath);
}

const NOW = "2026-01-01T00:00:00.000Z";

function buildCandidate(
  candidateId: string,
  overrides: Partial<ComparisonCandidateRecord> = {},
): ComparisonCandidateRecord {
  return {
    candidateId,
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    status: overrides.status ?? "prepared",
    executionTrust: undefined,
    runId: undefined,
    agentId: undefined,
    createdAt: NOW,
    preparedAt: undefined,
    startedAt: undefined,
    completedAt: undefined,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    resultEvidence: undefined,
    safeFailureReason: undefined,
  };
}

function buildComparison(
  comparisonId: string,
  candidateStatus: ComparisonCandidateRecord["status"],
): AgentComparisonRecord {
  return {
    comparisonId,
    sourceTaskId: "task-1",
    title: "Compare",
    description: "",
    priority: "normal",
    requirements: undefined,
    baseCommit: undefined,
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
    preparedAt: undefined,
    candidates: [
      buildCandidate(`${comparisonId}-a`, { status: candidateStatus }),
      buildCandidate(`${comparisonId}-b`),
    ],
    cleanupStatus: "not_started",
    cleanupError: undefined,
    prepareFailureCode: undefined,
    prepareFailureReason: undefined,
    preference: undefined,
  };
}

describe("classifyComparisonWorktrees / scanOrphanWorktrees", () => {
  let tempRoot: string;
  let sourceRepo: string;
  let comparisonRoot: string;
  let db: HallDatabase;
  let internalPaths: SqliteComparisonInternalPaths;
  let comparisonStore: SqliteComparisonStore;
  let gitWorktreeManager: GitWorktreeManager;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-classify-worktrees-"));
    sourceRepo = path.join(tempRoot, "source-repo");
    fs.mkdirSync(sourceRepo);
    initRepoWithCommit(sourceRepo);
    comparisonRoot = path.join(tempRoot, "comparison-root");
    fs.mkdirSync(comparisonRoot);
    comparisonRoot = fs.realpathSync.native(comparisonRoot);

    db = HallDatabase.openInMemory();
    runMigrations(db);
    internalPaths = new SqliteComparisonInternalPaths({ db });
    comparisonStore = new SqliteComparisonStore({ db, maxComparisons: 50 });
    gitWorktreeManager = new GitWorktreeManager({
      spawner: nodeProcessSpawner,
      gitExecutablePath: "git",
      timeoutMs: 15000,
      comparisonRoot,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("classifies a real, still-in-use worktree as healthy", async () => {
    const headCommit = await gitWorktreeManager.resolveHeadCommit(sourceRepo);
    const { worktreePath } = await gitWorktreeManager.createWorktree({
      repositoryPath: sourceRepo,
      baseCommit: headCommit,
      worktreeId: "cmp-1-a",
    });
    comparisonStore.add(buildComparison("cmp-1", "prepared"));
    internalPaths.setWorktreePath("cmp-1-a", "cmp-1", worktreePath);

    const results = await classifyComparisonWorktrees({
      internalPaths,
      comparisonStore,
      gitWorktreeManager,
      interruptedCandidateIds: new Set(),
    });

    expect(results).toEqual([{ candidateId: "cmp-1-a", comparisonId: "cmp-1", health: "healthy" }]);
  });

  it("classifies a real worktree whose candidate already finished as cleanup_required", async () => {
    const headCommit = await gitWorktreeManager.resolveHeadCommit(sourceRepo);
    const { worktreePath } = await gitWorktreeManager.createWorktree({
      repositoryPath: sourceRepo,
      baseCommit: headCommit,
      worktreeId: "cmp-1-a",
    });
    comparisonStore.add(buildComparison("cmp-1", "completed"));
    internalPaths.setWorktreePath("cmp-1-a", "cmp-1", worktreePath);

    const results = await classifyComparisonWorktrees({
      internalPaths,
      comparisonStore,
      gitWorktreeManager,
      interruptedCandidateIds: new Set(),
    });

    expect(results).toEqual([
      { candidateId: "cmp-1-a", comparisonId: "cmp-1", health: "cleanup_required" },
    ]);
  });

  it("classifies a candidate recovery just marked interrupted as 'interrupted', even though its status is terminal (failed)", async () => {
    const headCommit = await gitWorktreeManager.resolveHeadCommit(sourceRepo);
    const { worktreePath } = await gitWorktreeManager.createWorktree({
      repositoryPath: sourceRepo,
      baseCommit: headCommit,
      worktreeId: "cmp-1-a",
    });
    comparisonStore.add(buildComparison("cmp-1", "failed"));
    internalPaths.setWorktreePath("cmp-1-a", "cmp-1", worktreePath);

    const results = await classifyComparisonWorktrees({
      internalPaths,
      comparisonStore,
      gitWorktreeManager,
      interruptedCandidateIds: new Set(["cmp-1-a"]),
    });

    expect(results).toEqual([
      { candidateId: "cmp-1-a", comparisonId: "cmp-1", health: "interrupted" },
    ]);
  });

  it("classifies a path that no longer exists on disk as workspace_missing", async () => {
    const missingPath = path.join(comparisonRoot, "does-not-exist");
    comparisonStore.add(buildComparison("cmp-1", "prepared"));
    internalPaths.setWorktreePath("cmp-1-a", "cmp-1", missingPath);

    const results = await classifyComparisonWorktrees({
      internalPaths,
      comparisonStore,
      gitWorktreeManager,
      interruptedCandidateIds: new Set(),
    });

    expect(results).toEqual([
      { candidateId: "cmp-1-a", comparisonId: "cmp-1", health: "workspace_missing" },
    ]);
  });

  it("classifies an existing directory that is not a git repository as workspace_unverified", async () => {
    const notAGitRepo = path.join(comparisonRoot, "not-a-git-repo");
    fs.mkdirSync(notAGitRepo);
    comparisonStore.add(buildComparison("cmp-1", "prepared"));
    internalPaths.setWorktreePath("cmp-1-a", "cmp-1", notAGitRepo);

    const results = await classifyComparisonWorktrees({
      internalPaths,
      comparisonStore,
      gitWorktreeManager,
      interruptedCandidateIds: new Set(),
    });

    expect(results).toEqual([
      { candidateId: "cmp-1-a", comparisonId: "cmp-1", health: "workspace_unverified" },
    ]);
  });

  it("classifies a persisted path outside comparisonRoot as unsafe_path", async () => {
    comparisonStore.add(buildComparison("cmp-1", "prepared"));
    internalPaths.setWorktreePath("cmp-1-a", "cmp-1", sourceRepo);

    const results = await classifyComparisonWorktrees({
      internalPaths,
      comparisonStore,
      gitWorktreeManager,
      interruptedCandidateIds: new Set(),
    });

    expect(results).toEqual([
      { candidateId: "cmp-1-a", comparisonId: "cmp-1", health: "unsafe_path" },
    ]);
  });

  it("scanOrphanWorktrees counts directories under comparisonRoot with no persisted record, without naming them", async () => {
    const headCommit = await gitWorktreeManager.resolveHeadCommit(sourceRepo);
    const { worktreePath: knownPath } = await gitWorktreeManager.createWorktree({
      repositoryPath: sourceRepo,
      baseCommit: headCommit,
      worktreeId: "known-worktree",
    });
    fs.mkdirSync(path.join(comparisonRoot, "orphan-directory"));

    const count = scanOrphanWorktrees({
      comparisonRoot,
      knownWorktreePaths: new Set([knownPath]),
    });

    expect(count).toBe(1);
  });

  it("scanOrphanWorktrees returns 0 for a missing comparisonRoot rather than throwing", () => {
    const count = scanOrphanWorktrees({
      comparisonRoot: path.join(tempRoot, "does-not-exist"),
      knownWorktreePaths: new Set(),
    });
    expect(count).toBe(0);
  });
});
