import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidWorkingDirectoryError,
  WorkingDirectoryOutsideWorkspaceError,
} from "@hall-of-wisdom/hall-runner";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";
import { GitWorktreeManager } from "./git-worktree-manager.js";
import { NotAGitRepositoryError } from "./git-worktree-errors.js";
import { resolveSourceRepositoryRoot } from "./source-repository-resolution.js";
import { SourceWorkingDirectoryRequiredError } from "./source-repository-errors.js";

/**
 * Deterministic, no-real-`git`-process coverage for
 * `resolveSourceRepositoryRoot` — mirrors `git-worktree-manager.test.ts`'s
 * fake-spawner pattern exactly (an injected Git process fixture), so
 * `GitWorktreeManager.resolveRepositoryRoot` runs its real logic (realpath,
 * `git rev-parse --show-toplevel` parsing) against a fake `git` process
 * rather than a real one. Containment/existence checks (`validateWorkspace`)
 * still run against the real filesystem via real temp directories — only
 * the `git` subprocess itself is faked.
 */

function createFakeSpawner(
  handler: (args: readonly string[]) => { exitCode?: number; stdout?: string; stderr?: string },
): ProcessSpawner {
  return {
    spawn(_executablePath, args): SpawnedProcessHandle {
      const result = handler(args);
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      let exitCallback: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
      queueMicrotask(() => {
        if (result.stdout) stdout.emit("data", Buffer.from(result.stdout));
        if (result.stderr) stderr.emit("data", Buffer.from(result.stderr));
        exitCallback?.(result.exitCode ?? 0, null);
      });
      return {
        pid: 4242,
        stdin: { end: () => undefined } as unknown as NodeJS.WritableStream,
        stdout: stdout as unknown as NodeJS.ReadableStream,
        stderr: stderr as unknown as NodeJS.ReadableStream,
        onExit(callback) {
          exitCallback = callback;
        },
        onError() {
          // never used by this fixture.
        },
        kill() {
          return true;
        },
      };
    },
  };
}

describe("resolveSourceRepositoryRoot", () => {
  let workspaceRoot: string;
  let comparisonRoot: string;

  beforeEach(() => {
    // Canonicalized exactly like production always passes a canonical
    // `workspaceRoot` — see `git-worktree-manager.test.ts`'s identical
    // comment for why (Windows 8.3 short-name resolution).
    workspaceRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "hall-source-resolution-workspace-")),
    );
    comparisonRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "hall-source-resolution-comparison-root-")),
    );
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(comparisonRoot, { recursive: true, force: true });
  });

  function buildManager(repositoryRootToReport: string): GitWorktreeManager {
    return new GitWorktreeManager({
      spawner: createFakeSpawner((args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return { exitCode: 0, stdout: `${repositoryRootToReport}\n` };
        }
        return { exitCode: 0 };
      }),
      gitExecutablePath: "git",
      timeoutMs: 5000,
      comparisonRoot,
    });
  }

  function buildFailingManager(): GitWorktreeManager {
    return new GitWorktreeManager({
      spawner: createFakeSpawner(() => ({
        exitCode: 128,
        stderr: "fatal: not a git repository",
      })),
      gitExecutablePath: "git",
      timeoutMs: 5000,
      comparisonRoot,
    });
  }

  // #1/#8 — missing working directory is rejected.
  it("rejects when the task has no working directory recorded at all", async () => {
    const manager = buildFailingManager();
    await expect(
      resolveSourceRepositoryRoot({
        workspaceRoot,
        rawWorkingDirectory: undefined,
        gitWorktreeManager: manager,
        sourceTaskId: "task-1",
      }),
    ).rejects.toThrow(SourceWorkingDirectoryRequiredError);
  });

  // #4 — task working directory equal to the repository root is accepted.
  it("resolves a task working directory that IS the repository root", async () => {
    const manager = buildManager(workspaceRoot);
    const root = await resolveSourceRepositoryRoot({
      workspaceRoot,
      rawWorkingDirectory: ".",
      gitWorktreeManager: manager,
      sourceTaskId: "task-1",
    });
    expect(root).toBe(workspaceRoot);
  });

  // #3/#5 — a clean nested source repository, and a subdirectory of it, both resolve to the repo's top level.
  it("resolves a task working directory nested inside a repository subdirectory to that repository's top level", async () => {
    const repoRoot = path.join(workspaceRoot, "nested-repo");
    const subdirectory = path.join(repoRoot, "src");
    fs.mkdirSync(subdirectory, { recursive: true });
    const manager = buildManager(repoRoot);

    const root = await resolveSourceRepositoryRoot({
      workspaceRoot,
      rawWorkingDirectory: path.join("nested-repo", "src"),
      gitWorktreeManager: manager,
      sourceTaskId: "task-1",
    });
    expect(root).toBe(fs.realpathSync.native(repoRoot));
  });

  // #6 — two tasks under different repositories resolve independently; #7 — repository A is never substituted for task repository B.
  it("resolves two different tasks' working directories to two different, independent repositories", async () => {
    const repoA = path.join(workspaceRoot, "repo-a");
    const repoB = path.join(workspaceRoot, "repo-b");
    fs.mkdirSync(repoA);
    fs.mkdirSync(repoB);

    const rootA = await resolveSourceRepositoryRoot({
      workspaceRoot,
      rawWorkingDirectory: "repo-a",
      gitWorktreeManager: buildManager(repoA),
      sourceTaskId: "task-a",
    });
    const rootB = await resolveSourceRepositoryRoot({
      workspaceRoot,
      rawWorkingDirectory: "repo-b",
      gitWorktreeManager: buildManager(repoB),
      sourceTaskId: "task-b",
    });

    expect(rootA).toBe(fs.realpathSync.native(repoA));
    expect(rootB).toBe(fs.realpathSync.native(repoB));
    expect(rootA).not.toBe(rootB);
  });

  // #9 — a non-existent task working directory is rejected.
  it("rejects a working directory that does not exist on disk", async () => {
    const manager = buildFailingManager();
    await expect(
      resolveSourceRepositoryRoot({
        workspaceRoot,
        rawWorkingDirectory: "does-not-exist",
        gitWorktreeManager: manager,
        sourceTaskId: "task-1",
      }),
    ).rejects.toThrow(InvalidWorkingDirectoryError);
  });

  // #10 — a task working directory that exists but is not inside a Git repository is rejected.
  it("rejects a working directory that exists but is not inside a Git repository", async () => {
    const plainDirectory = path.join(workspaceRoot, "not-a-repo");
    fs.mkdirSync(plainDirectory);
    const manager = buildFailingManager();

    await expect(
      resolveSourceRepositoryRoot({
        workspaceRoot,
        rawWorkingDirectory: "not-a-repo",
        gitWorktreeManager: manager,
        sourceTaskId: "task-1",
      }),
    ).rejects.toThrow(NotAGitRepositoryError);
  });

  // #11 — a task working directory outside workspaceRoot is rejected.
  it("rejects a working directory that resolves outside workspaceRoot via traversal", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hall-source-resolution-outside-"));
    try {
      const manager = buildFailingManager();
      const relativeTraversal = path.relative(workspaceRoot, outside);
      await expect(
        resolveSourceRepositoryRoot({
          workspaceRoot,
          rawWorkingDirectory: relativeTraversal,
          gitWorktreeManager: manager,
          sourceTaskId: "task-1",
        }),
      ).rejects.toThrow(WorkingDirectoryOutsideWorkspaceError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // #12 — a symlink within workspaceRoot that resolves outside it is rejected.
  it("rejects a working directory that is a symlink resolving outside workspaceRoot", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hall-source-resolution-outside-"));
    const linkPath = path.join(workspaceRoot, "escape-link");
    try {
      fs.symlinkSync(outside, linkPath, "junction");
    } catch {
      // Symlink creation can require elevated privileges on Windows —
      // skip rather than fail the suite in an environment that forbids it.
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }
    try {
      const manager = buildFailingManager();
      await expect(
        resolveSourceRepositoryRoot({
          workspaceRoot,
          rawWorkingDirectory: "escape-link",
          gitWorktreeManager: manager,
          sourceTaskId: "task-1",
        }),
      ).rejects.toThrow(WorkingDirectoryOutsideWorkspaceError);
    } finally {
      fs.rmSync(linkPath, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  // #14 — a resolved Git root outside workspaceRoot is rejected (defense in depth against `git`'s own toplevel resolution disagreeing with the task's own containment check).
  it("rejects when the resolved Git repository root itself escapes workspaceRoot", async () => {
    const insideDirectory = path.join(workspaceRoot, "inside");
    fs.mkdirSync(insideDirectory);
    const outsideRepoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hall-source-resolution-outside-repo-"),
    );
    try {
      // Simulates `git rev-parse --show-toplevel` reporting a repository
      // root that is NOT an ancestor of the task's own (validly contained)
      // working directory — an unusual but real possibility (e.g. a
      // `.git`-file `gitdir:` indirection pointing elsewhere).
      const manager = buildManager(outsideRepoRoot);
      await expect(
        resolveSourceRepositoryRoot({
          workspaceRoot,
          rawWorkingDirectory: "inside",
          gitWorktreeManager: manager,
          sourceTaskId: "task-1",
        }),
      ).rejects.toThrow(WorkingDirectoryOutsideWorkspaceError);
    } finally {
      fs.rmSync(outsideRepoRoot, { recursive: true, force: true });
    }
  });
});
