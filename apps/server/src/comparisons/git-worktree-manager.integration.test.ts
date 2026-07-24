import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeProcessSpawner } from "./process-spawner.js";
import { GitWorktreeManager } from "./git-worktree-manager.js";
import { GitCommandFailedError, SourceRepositoryNotCleanError } from "./git-worktree-errors.js";

// Real `git` subprocess spawning is fast in isolation (a few hundred ms
// per call) but genuinely slow under the CPU/disk contention of
// `pnpm -r run test` running every workspace package's suite
// concurrently — the package-level default (10s, `vitest.config.ts`) is
// too tight for that combined load and was observed timing out here,
// which then leaves a `git.exe` handle open on Windows long enough for
// `afterEach`'s `fs.rmSync` to fail with EPERM. A generous per-file
// override, not a global config change, since this file's tests are the
// slow, I/O-heavy exception, not the norm for this package.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Real-`git` integration coverage for `GitWorktreeManager`, run against
 * genuine temp-directory repositories — this is where worktree isolation
 * and path safety are actually proven end to end, not mocked. The
 * unit-level `git-worktree-manager.test.ts` (fake spawner) stays in the
 * fast path for error-wrapping/identifier-safety/containment logic; this
 * file is the deterministic-but-slower proof that the real `git worktree`
 * commands this class issues behave exactly as every other test assumes.
 */

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function initRepoWithCommit(repoPath: string): string {
  git(["init", "--quiet"], repoPath);
  git(["config", "user.email", "hall-of-wisdom-test@example.com"], repoPath);
  git(["config", "user.name", "Hall of Wisdom Test"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "hello\n");
  git(["add", "README.md"], repoPath);
  git(["commit", "--quiet", "-m", "initial commit"], repoPath);
  return git(["rev-parse", "HEAD"], repoPath);
}

describe("GitWorktreeManager (real git, temp repositories)", () => {
  let comparisonRoot: string;
  let repositoryPath: string;
  let manager: GitWorktreeManager;

  beforeEach(() => {
    comparisonRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "hall-comparison-root-")),
    );
    repositoryPath = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "hall-comparison-repo-")),
    );
    manager = new GitWorktreeManager({
      spawner: nodeProcessSpawner,
      gitExecutablePath: "git",
      timeoutMs: 15000,
      comparisonRoot,
    });
  });

  afterEach(() => {
    fs.rmSync(comparisonRoot, { recursive: true, force: true });
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  });

  it("resolves the repository root and HEAD commit of a freshly initialized repository", async () => {
    const commit = initRepoWithCommit(repositoryPath);
    const root = await manager.resolveRepositoryRoot(repositoryPath);
    expect(fs.realpathSync.native(root)).toBe(repositoryPath);
    const head = await manager.resolveHeadCommit(repositoryPath);
    expect(head).toBe(commit);
  });

  it("assertWorkingTreeClean resolves for a freshly committed repository and rejects once a file is modified", async () => {
    initRepoWithCommit(repositoryPath);
    await expect(manager.assertWorkingTreeClean(repositoryPath)).resolves.toBeUndefined();

    fs.appendFileSync(path.join(repositoryPath, "README.md"), "more\n");
    await expect(manager.assertWorkingTreeClean(repositoryPath)).rejects.toThrow(
      SourceRepositoryNotCleanError,
    );
  });

  it("assertWorkingTreeClean rejects when an untracked file is present", async () => {
    initRepoWithCommit(repositoryPath);
    fs.writeFileSync(path.join(repositoryPath, "untracked.txt"), "new\n");
    await expect(manager.assertWorkingTreeClean(repositoryPath)).rejects.toThrow(
      SourceRepositoryNotCleanError,
    );
  });

  it("creates a real detached worktree checked out at the exact base commit, contained within the comparison root", async () => {
    const commit = initRepoWithCommit(repositoryPath);
    const { worktreePath } = await manager.createWorktree({
      repositoryPath,
      baseCommit: commit,
      worktreeId: "candidate-a",
    });

    expect(fs.existsSync(path.join(worktreePath, "README.md"))).toBe(true);
    expect(git(["rev-parse", "HEAD"], worktreePath)).toBe(commit);

    const relative = path.relative(comparisonRoot, worktreePath);
    expect(relative.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);

    // Detached HEAD, not checked out on a branch.
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath)).toBe("HEAD");
  });

  it("creates two independent worktrees for the same base commit with no shared writable workspace", async () => {
    const commit = initRepoWithCommit(repositoryPath);
    const a = await manager.createWorktree({
      repositoryPath,
      baseCommit: commit,
      worktreeId: "candidate-a",
    });
    const b = await manager.createWorktree({
      repositoryPath,
      baseCommit: commit,
      worktreeId: "candidate-b",
    });

    expect(a.worktreePath).not.toBe(b.worktreePath);

    fs.writeFileSync(path.join(a.worktreePath, "only-in-a.txt"), "a\n");
    expect(fs.existsSync(path.join(b.worktreePath, "only-in-a.txt"))).toBe(false);
  });

  it("never creates a branch, commit, or remote reference in the source repository as a side effect of creating a worktree", async () => {
    const commit = initRepoWithCommit(repositoryPath);
    const branchesBefore = git(["branch", "--list"], repositoryPath);
    const remotesBefore = git(["remote"], repositoryPath);

    await manager.createWorktree({ repositoryPath, baseCommit: commit, worktreeId: "candidate-a" });

    expect(git(["branch", "--list"], repositoryPath)).toBe(branchesBefore);
    expect(git(["remote"], repositoryPath)).toBe(remotesBefore);
    expect(git(["rev-parse", "HEAD"], repositoryPath)).toBe(commit);
  });

  it("removes a worktree via git worktree remove, leaving the source repository's own commit untouched", async () => {
    const commit = initRepoWithCommit(repositoryPath);
    const { worktreePath } = await manager.createWorktree({
      repositoryPath,
      baseCommit: commit,
      worktreeId: "candidate-a",
    });

    await manager.removeWorktree(repositoryPath, worktreePath);

    expect(fs.existsSync(worktreePath)).toBe(false);
    const list = git(["worktree", "list", "--porcelain"], repositoryPath);
    expect(list).not.toContain(worktreePath);
    expect(git(["rev-parse", "HEAD"], repositoryPath)).toBe(commit);
  });

  it("removes a worktree that an agent left dirty — a modified tracked file and a new untracked file", async () => {
    const commit = initRepoWithCommit(repositoryPath);
    const { worktreePath } = await manager.createWorktree({
      repositoryPath,
      baseCommit: commit,
      worktreeId: "candidate-dirty",
    });

    // Simulates what a real candidate run leaves behind: an edited
    // tracked file plus a newly created untracked one — this is the
    // worktree state `removeWorktree` must actually handle in
    // production (every prior removal test above used an untouched
    // worktree, which `git worktree remove --force` would trivially
    // succeed against even if `--force` weren't doing anything).
    fs.appendFileSync(path.join(worktreePath, "README.md"), "edited by agent\n");
    fs.writeFileSync(path.join(worktreePath, "new-file-from-agent.txt"), "new\n");

    await manager.removeWorktree(repositoryPath, worktreePath);

    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(["worktree", "list", "--porcelain"], repositoryPath)).not.toContain(worktreePath);
  });

  it("a second removeWorktree call against an already-removed worktree fails, and pruneWorktrees still clears its metadata afterward", async () => {
    const commit = initRepoWithCommit(repositoryPath);
    const { worktreePath } = await manager.createWorktree({
      repositoryPath,
      baseCommit: commit,
      worktreeId: "candidate-retry",
    });

    await manager.removeWorktree(repositoryPath, worktreePath);
    // The building block a future cleanup-status retry path depends on:
    // retrying `removeWorktree` against a worktree that is already gone
    // fails deterministically (never silently succeeds, never throws
    // something uncatchable) rather than leaving the caller unsure
    // whether cleanup completed.
    await expect(manager.removeWorktree(repositoryPath, worktreePath)).rejects.toThrow(
      GitCommandFailedError,
    );

    // The retry path's fallback: pruneWorktrees is safe and idempotent
    // to call afterward, and leaves no stale administrative metadata.
    await manager.pruneWorktrees(repositoryPath);
    expect(git(["worktree", "list", "--porcelain"], repositoryPath)).not.toContain(
      "candidate-retry",
    );
  });

  it("pruneWorktrees clears stale administrative metadata after an out-of-band directory removal", async () => {
    const commit = initRepoWithCommit(repositoryPath);
    await manager.createWorktree({ repositoryPath, baseCommit: commit, worktreeId: "candidate-a" });

    const worktreeDir = path.join(comparisonRoot, "candidate-a");
    // Simulate an out-of-band removal (not via `git worktree remove`).
    fs.rmSync(worktreeDir, { recursive: true, force: true });

    const beforePrune = git(["worktree", "list", "--porcelain"], repositoryPath);
    expect(beforePrune).toContain("candidate-a");

    await manager.pruneWorktrees(repositoryPath);

    const afterPrune = git(["worktree", "list", "--porcelain"], repositoryPath);
    expect(afterPrune).not.toContain("candidate-a");
  });

  it("rejects creating a worktree at a commit that does not exist in the repository", async () => {
    initRepoWithCommit(repositoryPath);
    const bogusCommit = "0".repeat(40);
    await expect(
      manager.createWorktree({
        repositoryPath,
        baseCommit: bogusCommit,
        worktreeId: "candidate-a",
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(comparisonRoot, "candidate-a"))).toBe(false);
  });

  // "resolveRepositoryRoot rejects a directory with no .git anywhere up the
  // tree" is intentionally NOT covered here: `os.tmpdir()` in some
  // environments (e.g. a home directory that is itself Git-tracked, as
  // observed in this repo's own dev environment) sits underneath an
  // ambient repository, making that scenario flaky and environment-
  // dependent through no fault of this class. The invariant itself —
  // `NotAGitRepositoryError` thrown when `git rev-parse --show-toplevel`
  // exits non-zero — is already deterministically covered by the
  // fake-spawner unit test of the same name in `git-worktree-manager.test.ts`.

  it("resolveRepositoryRoot resolves the true repository root from a subdirectory", async () => {
    initRepoWithCommit(repositoryPath);
    const subdir = path.join(repositoryPath, "nested", "dir");
    fs.mkdirSync(subdir, { recursive: true });
    const root = await manager.resolveRepositoryRoot(subdir);
    expect(fs.realpathSync.native(root)).toBe(repositoryPath);
  });
});
