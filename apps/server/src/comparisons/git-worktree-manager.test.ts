import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessSpawner, SpawnedProcessHandle, SpawnOptions } from "./process-spawner.js";
import { GitWorktreeManager } from "./git-worktree-manager.js";
import {
  GitCommandFailedError,
  InvalidWorktreeIdentifierError,
  NotAGitRepositoryError,
  SourceRepositoryNotCleanError,
  WorktreeAlreadyExistsError,
  WorktreeCommitMismatchError,
  WorktreeRemovalRefusedError,
} from "./git-worktree-errors.js";

/**
 * Deterministic, no-real-process `ProcessSpawner` fake. `handler` decides
 * what each invocation "returns" (exit code / stdout / stderr / a spawn
 * error) and may perform a filesystem side effect (e.g. simulating
 * `git worktree add` actually creating a directory) — real
 * `GitWorktreeManager` logic downstream of the spawn (realpath,
 * containment, commit verification) still runs against the real
 * filesystem, only the `git` process itself is faked.
 */
interface FakeResult {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly signal?: NodeJS.Signals | null;
  readonly spawnError?: string;
  /** Never settles — used to exercise the real bounded-process timeout path. */
  readonly hang?: boolean;
}

function createFakeSpawner(
  handler: (executablePath: string, args: readonly string[], options: SpawnOptions) => FakeResult,
  onCall?: (args: readonly string[]) => void,
): ProcessSpawner {
  return {
    spawn(executablePath, args, options) {
      onCall?.(args);
      const result = handler(executablePath, args, options);
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      let exitCallback: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
      let errorCallback: ((error: Error) => void) | undefined;

      if (!result.hang) {
        queueMicrotask(() => {
          if (result.stdout) stdout.emit("data", Buffer.from(result.stdout));
          if (result.stderr) stderr.emit("data", Buffer.from(result.stderr));
          if (result.spawnError !== undefined) {
            errorCallback?.(new Error(result.spawnError));
          } else {
            exitCallback?.(result.exitCode ?? 0, result.signal ?? null);
          }
        });
      }

      const handle: SpawnedProcessHandle = {
        pid: 4242,
        stdin: { end: () => undefined } as unknown as NodeJS.WritableStream,
        stdout: stdout as unknown as NodeJS.ReadableStream,
        stderr: stderr as unknown as NodeJS.ReadableStream,
        onExit(callback) {
          exitCallback = callback;
        },
        onError(callback) {
          errorCallback = callback;
        },
        kill() {
          // Simulates a real child process's "exit" event firing once it
          // actually receives the signal — without this, a `hang: true`
          // fake never settles `runBoundedProcess`'s promise even after
          // its timeout calls `kill()`.
          if (result.hang) {
            queueMicrotask(() => {
              exitCallback?.(null, "SIGTERM");
            });
          }
          return true;
        },
      };
      return handle;
    },
  };
}

const FAKE_COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);

/** Simulates `git worktree add`'s real side effect (creating the target directory) inside a fake-spawner handler, given that command's fixed argv shape (`["worktree", "add", "--detach", intendedPath, baseCommit]`). */
function simulateWorktreeAddSideEffect(args: readonly string[]): void {
  const intendedPath = args[3];
  if (intendedPath === undefined) {
    throw new Error('test fixture: expected "worktree add" args[3] to be the intended path');
  }
  fs.mkdirSync(intendedPath, { recursive: true });
}

describe("GitWorktreeManager (fake spawner)", () => {
  let comparisonRoot: string;
  let repositoryPath: string;

  beforeEach(() => {
    // Canonicalized (realpath'd) exactly like production always passes a
    // canonical `comparisonRoot` into this class (see `server.ts` /
    // `validateWorkspace`) — on Windows, `os.tmpdir()` can resolve through
    // an 8.3 short-name path segment (e.g. `MOHAMM~1`) that differs from
    // the long-form path `fs.realpathSync.native` returns for anything
    // created under it, which would otherwise make every genuinely
    // contained worktree look like a containment violation.
    comparisonRoot = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "hall-comparison-root-")),
    );
    repositoryPath = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "hall-comparison-repo-")),
    );
  });

  afterEach(() => {
    fs.rmSync(comparisonRoot, { recursive: true, force: true });
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  });

  function buildManager(
    handler: (executablePath: string, args: readonly string[], options: SpawnOptions) => FakeResult,
    onCall?: (args: readonly string[]) => void,
    timeoutMs = 5000,
  ): GitWorktreeManager {
    return new GitWorktreeManager({
      spawner: createFakeSpawner(handler, onCall),
      gitExecutablePath: "git",
      timeoutMs,
      comparisonRoot,
    });
  }

  describe("createWorktree — identifier safety", () => {
    it("rejects a path-traversal worktree identifier without ever invoking git", () => {
      const calls: (readonly string[])[] = [];
      const manager = buildManager(
        () => ({ exitCode: 0 }),
        (args) => calls.push(args),
      );

      return expect(
        manager.createWorktree({
          repositoryPath,
          baseCommit: FAKE_COMMIT,
          worktreeId: "../escape",
        }),
      )
        .rejects.toThrow(InvalidWorktreeIdentifierError)
        .then(() => {
          expect(calls).toHaveLength(0);
        });
    });

    it("rejects a worktree identifier containing a path separator", async () => {
      const manager = buildManager(() => ({ exitCode: 0 }));
      await expect(
        manager.createWorktree({ repositoryPath, baseCommit: FAKE_COMMIT, worktreeId: "a/b" }),
      ).rejects.toThrow(InvalidWorktreeIdentifierError);
    });

    it("rejects an empty worktree identifier", async () => {
      const manager = buildManager(() => ({ exitCode: 0 }));
      await expect(
        manager.createWorktree({ repositoryPath, baseCommit: FAKE_COMMIT, worktreeId: "" }),
      ).rejects.toThrow(InvalidWorktreeIdentifierError);
    });
  });

  it("rejects createWorktree when the intended path already exists, without invoking git", async () => {
    const worktreeId = "already-exists";
    fs.mkdirSync(path.join(comparisonRoot, worktreeId));
    const calls: (readonly string[])[] = [];
    const manager = buildManager(
      () => ({ exitCode: 0 }),
      (args) => calls.push(args),
    );

    await expect(
      manager.createWorktree({ repositoryPath, baseCommit: FAKE_COMMIT, worktreeId }),
    ).rejects.toThrow(WorktreeAlreadyExistsError);
    expect(calls).toHaveLength(0);
  });

  it("creates a worktree and returns its canonical, commit-verified path when HEAD matches", async () => {
    const worktreeId = "matching-commit";
    const manager = buildManager((_exe, args) => {
      if (args[0] === "worktree" && args[1] === "add") {
        simulateWorktreeAddSideEffect(args);
        return { exitCode: 0 };
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { exitCode: 0, stdout: `${FAKE_COMMIT}\n` };
      }
      return { exitCode: 0 };
    });

    const result = await manager.createWorktree({
      repositoryPath,
      baseCommit: FAKE_COMMIT,
      worktreeId,
    });
    expect(fs.existsSync(result.worktreePath)).toBe(true);
  });

  it("rolls back (removes) and throws WorktreeCommitMismatchError when post-creation HEAD does not match the requested base commit", async () => {
    const worktreeId = "mismatched-commit";
    const removeCalls: (readonly string[])[] = [];
    const manager = buildManager(
      (_exe, args) => {
        if (args[0] === "worktree" && args[1] === "add") {
          simulateWorktreeAddSideEffect(args);
          return { exitCode: 0 };
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { exitCode: 0, stdout: `${OTHER_COMMIT}\n` };
        }
        return { exitCode: 0 };
      },
      (args) => {
        if (args[0] === "worktree" && args[1] === "remove") removeCalls.push(args);
      },
    );

    await expect(
      manager.createWorktree({ repositoryPath, baseCommit: FAKE_COMMIT, worktreeId }),
    ).rejects.toThrow(WorktreeCommitMismatchError);
    expect(removeCalls).toHaveLength(1);
  });

  describe("removeWorktree — containment refusal", () => {
    it("refuses to remove a path outside the comparison root, without invoking git", async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hall-comparison-outside-"));
      const calls: (readonly string[])[] = [];
      const manager = buildManager(
        () => ({ exitCode: 0 }),
        (args) => calls.push(args),
      );
      try {
        await expect(manager.removeWorktree(repositoryPath, outside)).rejects.toThrow(
          WorktreeRemovalRefusedError,
        );
        expect(calls).toHaveLength(0);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("refuses to remove a prefix-confusion sibling of the comparison root", async () => {
      const sibling = `${comparisonRoot}-other`;
      fs.mkdirSync(sibling);
      const manager = buildManager(() => ({ exitCode: 0 }));
      try {
        await expect(manager.removeWorktree(repositoryPath, sibling)).rejects.toThrow(
          WorktreeRemovalRefusedError,
        );
      } finally {
        fs.rmSync(sibling, { recursive: true, force: true });
      }
    });

    it("removes a worktree path genuinely inside the comparison root", async () => {
      const inside = path.join(comparisonRoot, "inside-worktree");
      fs.mkdirSync(inside);
      const manager = buildManager(() => ({ exitCode: 0 }));
      await expect(manager.removeWorktree(repositoryPath, inside)).resolves.toBeUndefined();
    });
  });

  describe("git command failure wrapping", () => {
    it("wraps a non-zero git exit code as GitCommandFailedError", async () => {
      const manager = buildManager(() => ({
        exitCode: 128,
        stderr: "fatal: not a git repository",
      }));
      await expect(manager.resolveHeadCommit(repositoryPath)).rejects.toThrow(
        GitCommandFailedError,
      );
    });

    it("wraps a spawn error as GitCommandFailedError", async () => {
      const manager = buildManager(() => ({ spawnError: "ENOENT: git not found" }));
      await expect(manager.resolveHeadCommit(repositoryPath)).rejects.toThrow(
        GitCommandFailedError,
      );
    });

    it("wraps a process timeout as GitCommandFailedError", async () => {
      const manager = buildManager(() => ({ hang: true }), undefined, 20);
      await expect(manager.resolveHeadCommit(repositoryPath)).rejects.toThrow(
        GitCommandFailedError,
      );
    });

    it("resolveRepositoryRoot throws NotAGitRepositoryError when rev-parse --show-toplevel fails", async () => {
      const manager = buildManager(() => ({
        exitCode: 128,
        stderr: "fatal: not a git repository",
      }));
      await expect(manager.resolveRepositoryRoot(repositoryPath)).rejects.toThrow(
        NotAGitRepositoryError,
      );
    });

    it("resolveHeadCommit throws GitCommandFailedError when git prints something that is not a full commit SHA", async () => {
      const manager = buildManager(() => ({ exitCode: 0, stdout: "not-a-sha\n" }));
      await expect(manager.resolveHeadCommit(repositoryPath)).rejects.toThrow(
        GitCommandFailedError,
      );
    });
  });

  describe("assertWorkingTreeClean", () => {
    it("throws SourceRepositoryNotCleanError when status --porcelain reports changes", async () => {
      const manager = buildManager(() => ({ exitCode: 0, stdout: " M some-file.txt\n" }));
      await expect(manager.assertWorkingTreeClean(repositoryPath)).rejects.toThrow(
        SourceRepositoryNotCleanError,
      );
    });

    it("resolves when status --porcelain reports no changes", async () => {
      const manager = buildManager(() => ({ exitCode: 0, stdout: "" }));
      await expect(manager.assertWorkingTreeClean(repositoryPath)).resolves.toBeUndefined();
    });
  });

  it("pruneWorktrees invokes git worktree prune and resolves on success", async () => {
    const calls: (readonly string[])[] = [];
    const manager = buildManager(
      () => ({ exitCode: 0 }),
      (args) => calls.push(args),
    );
    await manager.pruneWorktrees(repositoryPath);
    expect(calls).toEqual([["worktree", "prune"]]);
  });
});
