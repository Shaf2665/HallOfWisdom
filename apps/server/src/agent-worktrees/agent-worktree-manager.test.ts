import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentWorktreeGitOperationError,
  AgentWorktreeSourceNotCleanError,
} from "./agent-worktree-errors.js";
import { AgentWorktreeManager } from "./agent-worktree-manager.js";
import { InMemoryAgentWorktreeStore } from "./in-memory-agent-worktree-store.js";
import {
  NodeGitCommandRunner,
  type GitCommandRunner,
  type GitCommandResult,
} from "./git-command-runner.js";

const BASE_NOW = "2026-08-02T10:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentWorktreeManager", () => {
  it("creates a detached worktree at source HEAD and maps a source subdirectory", async () => {
    const fixture = createFixtureRepository("repo with spaces");
    const sourceSubdir = path.join(fixture.repo, "apps", "server");
    const ownedRoot = makeTempDir("hall owned worktrees ");
    const statusBefore = sourceState(fixture.repo);

    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: new NodeGitCommandRunner(),
      ownedRoot,
      now: () => BASE_NOW,
      idGenerator: () => "run-safe-id",
    });

    const result = await manager.createWorktree({
      hallTaskId: "task-title-cannot-affect-path",
      hallAgentRunId: "agent-run-1",
      sourceWorkingDirectory: sourceSubdir,
    });

    expect(result.record.status).toBe("ready");
    expect(result.record.baseCommit).toBe(fixture.head);
    expect(result.record.sourceWorkingDirectoryRelativePath).toBe(path.join("apps", "server"));
    expect(result.agentWorkingDirectory).toBe(
      fs.realpathSync.native(path.join(result.record.canonicalWorktreePath, "apps", "server")),
    );
    expect(
      git(["rev-parse", "--verify", "HEAD^{commit}"], result.record.canonicalWorktreePath),
    ).toBe(fixture.head);
    expect(() =>
      git(["symbolic-ref", "-q", "--short", "HEAD"], result.record.canonicalWorktreePath),
    ).toThrow();
    expect(git(["branch", "--list", "run-safe-id"], fixture.repo)).toBe("");
    expect(sourceState(fixture.repo)).toEqual(statusBefore);
  });

  it.each([
    [
      "modified tracked file",
      (repo: string) => {
        fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
      },
    ],
    [
      "staged change",
      (repo: string) => {
        fs.writeFileSync(path.join(repo, "staged.txt"), "staged\n");
        git(["add", "staged.txt"], repo);
      },
    ],
    [
      "untracked file",
      (repo: string) => {
        fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n");
      },
    ],
  ])("rejects a dirty source repository with a %s", async (_label, dirty) => {
    const fixture = createFixtureRepository("dirty repo");
    dirty(fixture.repo);
    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: new NodeGitCommandRunner(),
      ownedRoot: makeTempDir("hall owned worktrees "),
      idGenerator: () => "dirty-run",
    });
    await expect(
      manager.createWorktree({
        hallTaskId: "task-1",
        hallAgentRunId: "run-1",
        sourceWorkingDirectory: fixture.repo,
      }),
    ).rejects.toThrow(AgentWorktreeSourceNotCleanError);
  });

  it("rejects unresolved conflicts where practical", async () => {
    const fixture = createFixtureRepository("conflict repo");
    git(["checkout", "-b", "side"], fixture.repo);
    fs.writeFileSync(path.join(fixture.repo, "README.md"), "side\n");
    git(["add", "README.md"], fixture.repo);
    git(["commit", "-m", "side"], fixture.repo);
    git(["checkout", "main"], fixture.repo);
    fs.writeFileSync(path.join(fixture.repo, "README.md"), "main\n");
    git(["add", "README.md"], fixture.repo);
    git(["commit", "-m", "main"], fixture.repo);
    expect(() => git(["merge", "side"], fixture.repo)).toThrow();

    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: new NodeGitCommandRunner(),
      ownedRoot: makeTempDir("hall owned worktrees "),
      idGenerator: () => "conflict-run",
    });
    await expect(
      manager.createWorktree({
        hallTaskId: "task-1",
        hallAgentRunId: "run-1",
        sourceWorkingDirectory: fixture.repo,
      }),
    ).rejects.toThrow(AgentWorktreeSourceNotCleanError);
  });

  it("creates distinct worktrees for two separate agent runs", async () => {
    const fixture = createFixtureRepository("multi run repo");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: new NodeGitCommandRunner(),
      ownedRoot: makeTempDir("hall owned worktrees "),
      idGenerator: idSequence(["run-a", "run-b"]),
    });
    const first = await manager.createWorktree({
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      sourceWorkingDirectory: fixture.repo,
    });
    const second = await manager.createWorktree({
      hallTaskId: "task-2",
      hallAgentRunId: "run-2",
      sourceWorkingDirectory: fixture.repo,
    });
    expect(first.record.canonicalWorktreePath).not.toBe(second.record.canonicalWorktreePath);
    expect(store.list()).toHaveLength(2);
  });

  it("records creation_failed after a structured Git failure", async () => {
    const source = makeTempDir("fake source repo ");
    const store = new InMemoryAgentWorktreeStore();
    const runner = new ScriptedGitRunner([
      ok(source),
      ok(""),
      ok("a".repeat(40)),
      fail("fatal: cannot create worktree"),
    ]);
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: runner,
      ownedRoot: makeTempDir("fake owned root "),
      idGenerator: () => "fake-run",
      now: () => BASE_NOW,
    });
    await expect(
      manager.createWorktree({
        hallTaskId: "task-1",
        hallAgentRunId: "run-1",
        sourceWorkingDirectory: source,
      }),
    ).rejects.toThrow(AgentWorktreeGitOperationError);
    expect(store.get("fake-run").status).toBe("creation_failed");
    expect(runner.calls.map((call) => call.args)).toContainEqual([
      "worktree",
      "add",
      "--detach",
      path.join(
        fs.realpathSync.native(path.dirname(store.get("fake-run").canonicalWorktreePath)),
        "wt_fake-run",
      ),
      "a".repeat(40),
    ]);
  });

  it("cleans up a valid registered worktree by id without mutating the source checkout", async () => {
    const fixture = createFixtureRepository("cleanup repo");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: new NodeGitCommandRunner(),
      ownedRoot: makeTempDir("hall owned worktrees "),
      idGenerator: () => "cleanup-run",
    });
    const created = await manager.createWorktree({
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      sourceWorkingDirectory: fixture.repo,
    });
    const before = sourceState(fixture.repo);
    const cleaned = await manager.cleanupWorktree(created.record.worktreeId);
    expect(cleaned.status).toBe("cleaned");
    expect(fs.existsSync(created.record.canonicalWorktreePath)).toBe(false);
    expect(sourceState(fixture.repo)).toEqual(before);
  });

  it("handles an already-missing unregistered worktree idempotently", async () => {
    const fixture = createFixtureRepository("missing cleanup repo");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: new NodeGitCommandRunner(),
      ownedRoot: makeTempDir("hall owned worktrees "),
      idGenerator: () => "missing-run",
    });
    const created = await manager.createWorktree({
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      sourceWorkingDirectory: fixture.repo,
    });
    git(["worktree", "remove", "--force", created.record.canonicalWorktreePath], fixture.repo);
    const cleaned = await manager.cleanupWorktree(created.record.worktreeId);
    expect(cleaned.status).toBe("cleaned");
    expect(await manager.cleanupWorktree(created.record.worktreeId)).toEqual(cleaned);
  });

  it("does not recursively delete a worktree path when Git removal fails", async () => {
    const source = makeTempDir("cleanup failure repo ");
    const worktreePath = path.join(makeTempDir("cleanup failure owned "), "wt_cleanup-fail");
    fs.mkdirSync(worktreePath, { recursive: true });
    const store = new InMemoryAgentWorktreeStore();
    store.createCreating({
      worktreeId: "cleanup-fail",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      canonicalSourceRepositoryRoot: source,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: "a".repeat(40),
      canonicalWorktreePath: worktreePath,
      createdAt: BASE_NOW,
    });
    store.markReady({
      worktreeId: "cleanup-fail",
      expectedRevision: 0,
      readyAt: BASE_NOW,
    });
    const runner = new ScriptedGitRunner([ok(`worktree ${worktreePath}\n`), fail("locked file")]);
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: runner,
      ownedRoot: path.dirname(worktreePath),
    });
    await expect(manager.cleanupWorktree("cleanup-fail")).rejects.toThrow(
      AgentWorktreeGitOperationError,
    );
    expect(store.get("cleanup-fail").status).toBe("cleanup_failed");
    expect(fs.existsSync(worktreePath)).toBe(true);
  });
});

function createFixtureRepository(name: string): { readonly repo: string; readonly head: string } {
  const repo = path.join(makeTempDir("hall-agent-worktree-fixture "), name);
  fs.mkdirSync(path.join(repo, "apps", "server"), { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "Hall Test"], repo);
  git(["config", "user.email", "hall-test@example.invalid"], repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  fs.writeFileSync(path.join(repo, "apps", "server", "index.ts"), "export const x = 1;\n");
  git(["add", "README.md", "apps/server/index.ts"], repo);
  git(["commit", "-m", "initial"], repo);
  return {
    repo: fs.realpathSync.native(repo),
    head: git(["rev-parse", "--verify", "HEAD^{commit}"], repo),
  };
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
  }).trim();
}

function sourceState(repo: string): {
  readonly head: string;
  readonly branch: string;
  readonly status: string;
} {
  return {
    head: git(["rev-parse", "--verify", "HEAD^{commit}"], repo),
    branch: git(["branch", "--show-current"], repo),
    status: git(["status", "--porcelain=v1", "--untracked-files=all"], repo),
  };
}

function idSequence(ids: readonly string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    if (id === undefined) throw new Error("No more ids");
    index += 1;
    return id;
  };
}

function ok(stdout: string): GitCommandResult {
  return { exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, spawnError: undefined };
}

function fail(stderr: string): GitCommandResult {
  return { exitCode: 1, signal: null, stdout: "", stderr, timedOut: false, spawnError: undefined };
}

class ScriptedGitRunner implements GitCommandRunner {
  readonly calls: GitCommandRunner["run"] extends (input: infer Input) => Promise<GitCommandResult>
    ? Input[]
    : never[] = [];
  readonly #results: GitCommandResult[];

  constructor(results: GitCommandResult[]) {
    this.#results = [...results];
  }

  run(input: Parameters<GitCommandRunner["run"]>[0]): Promise<GitCommandResult> {
    this.calls.push(input);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("No scripted Git result");
    return Promise.resolve(result);
  }
}
