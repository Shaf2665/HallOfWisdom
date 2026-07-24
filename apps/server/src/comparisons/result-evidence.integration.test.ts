import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeProcessSpawner } from "./process-spawner.js";
import { captureResultEvidence } from "./result-evidence.js";

// See the identical override in git-worktree-manager.integration.test.ts
// for why this file's real-`git` tests need a more generous timeout than
// this package's 10s default under `pnpm -r run test`'s concurrent load.
vi.setConfig({ testTimeout: 30_000 });

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
  fs.writeFileSync(path.join(repoPath, "README.md"), "line one\nline two\n");
  fs.writeFileSync(path.join(repoPath, "to-delete.txt"), "gone soon\n");
  git(["add", "README.md", "to-delete.txt"], repoPath);
  git(["commit", "--quiet", "-m", "initial commit"], repoPath);
}

const CAPTURE_OPTIONS = {
  spawner: nodeProcessSpawner,
  gitExecutablePath: "git",
  timeoutMs: 10000,
  maxChangedFiles: 500,
  maxDiffChars: 200_000,
};

describe("captureResultEvidence (real git)", () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "hall-result-evidence-")),
    );
    initRepoWithCommit(worktreePath);
  });

  afterEach(() => {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });

  it("reports no changed files and no diff when the worktree is untouched", async () => {
    const evidence = await captureResultEvidence(worktreePath, CAPTURE_OPTIONS);
    expect(evidence.changedFiles).toEqual([]);
    expect(evidence.totalAdditions).toBe(0);
    expect(evidence.totalDeletions).toBe(0);
    expect(evidence.boundedDiff).toBeUndefined();
    expect(evidence.truncated).toBe(false);
  });

  it("reports a modified tracked file, a new untracked file, and a deleted file with correct stats", async () => {
    fs.appendFileSync(path.join(worktreePath, "README.md"), "line three\n");
    fs.writeFileSync(path.join(worktreePath, "new-file.txt"), "brand new\ncontent\n");
    fs.rmSync(path.join(worktreePath, "to-delete.txt"));

    const evidence = await captureResultEvidence(worktreePath, CAPTURE_OPTIONS);

    const byPath = new Map(evidence.changedFiles.map((entry) => [entry.relativePath, entry]));
    expect(byPath.get("README.md")).toEqual({
      relativePath: "README.md",
      changeType: "modified",
      additions: 1,
      deletions: 0,
    });
    expect(byPath.get("new-file.txt")).toEqual({
      relativePath: "new-file.txt",
      changeType: "added",
      additions: 2,
      deletions: 0,
    });
    expect(byPath.get("to-delete.txt")).toEqual({
      relativePath: "to-delete.txt",
      changeType: "deleted",
      additions: 0,
      deletions: 1,
    });
    expect(evidence.totalAdditions).toBe(3);
    expect(evidence.totalDeletions).toBe(1);
    expect(evidence.boundedDiff).toBeDefined();
    expect(evidence.boundedDiff).toContain("new-file.txt");
    expect(evidence.truncated).toBe(false);
  });

  it("never exposes the worktree's absolute path in the returned evidence", async () => {
    fs.writeFileSync(path.join(worktreePath, "new-file.txt"), "content\n");
    const evidence = await captureResultEvidence(worktreePath, CAPTURE_OPTIONS);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(worktreePath);
  });

  it("truncates the bounded diff and sets truncated when it exceeds maxDiffChars", async () => {
    fs.writeFileSync(
      path.join(worktreePath, "big-file.txt"),
      "x".repeat(1000).concat("\n").repeat(50),
    );
    const evidence = await captureResultEvidence(worktreePath, {
      ...CAPTURE_OPTIONS,
      maxDiffChars: 200,
    });
    expect(evidence.boundedDiff?.length).toBe(200);
    expect(evidence.truncated).toBe(true);
  });

  it("truncates the changed-files list and sets truncated when it exceeds maxChangedFiles", async () => {
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(path.join(worktreePath, `file-${String(i)}.txt`), "x\n");
    }
    const evidence = await captureResultEvidence(worktreePath, {
      ...CAPTURE_OPTIONS,
      maxChangedFiles: 2,
    });
    expect(evidence.changedFiles).toHaveLength(2);
    expect(evidence.truncated).toBe(true);
  });
});
