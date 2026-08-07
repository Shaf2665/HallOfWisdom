import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentWorktreeGitOperationError,
  AgentWorktreePathError,
  AgentWorktreeSourceNotCleanError,
} from "./agent-worktree-errors.js";
import { AgentWorktreeManager } from "./agent-worktree-manager.js";
import { InMemoryAgentWorktreeStore } from "./in-memory-agent-worktree-store.js";
import {
  NodeGitCommandRunner,
  nodeGitProcessSpawner,
  type GitCommandRunner,
  type GitCommandResult,
} from "./git-command-runner.js";
import { isPathContained } from "./path-safety.js";

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
      gitRunner: testGitRunner(),
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

  it("suppresses repository post-checkout hooks with a Hall-controlled empty hooks path", async () => {
    const fixture = createFixtureRepository("hook repo");
    const ownedRoot = makeTempDir("hall owned worktrees ");
    const sentinel = path.join(path.dirname(fixture.repo), "hook sentinel.txt");
    if (!installExecutablePostCheckoutHook(fixture.repo, sentinel)) {
      return undefined;
    }
    const runner = new RecordingGitRunner(testGitRunner());
    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: runner,
      ownedRoot,
      idGenerator: () => "hook-run",
    });

    const created = await manager.createWorktree({
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      sourceWorkingDirectory: fixture.repo,
    });

    expect(created.record.status).toBe("ready");
    expect(fs.existsSync(sentinel)).toBe(false);
    const checkoutCall = runner.calls.find((call) => call.args.includes("checkout"));
    expect(checkoutCall?.args).toContainEqual(expect.stringContaining("core.hooksPath="));
    const hooksOverride = checkoutCall?.args.find((arg) => arg.startsWith("core.hooksPath="));
    expect(hooksOverride).toBeDefined();
    const hooksDirectory = hooksOverride?.slice("core.hooksPath=".length);
    expect(hooksDirectory).toBeDefined();
    expect(isPathContained(ownedRoot, hooksDirectory ?? "")).toBe(true);
    expect(isPathContained(fixture.repo, hooksDirectory ?? "")).toBe(false);
    expect(fs.readdirSync(hooksDirectory ?? "")).toEqual([]);
  });

  it("rejects local checkout filters before checkout and without executing the filter", async () => {
    const fixture = createFixtureRepository("filter repo");
    const sentinel = path.join(path.dirname(fixture.repo), "filter sentinel.txt");
    const filterCommand = `sh -c ${shellQuote(
      `printf filter > ${shellQuote(toGitShellPath(sentinel))}`,
    )}`;
    fs.writeFileSync(path.join(fixture.repo, "filtered.txt"), "filtered\n");
    fs.writeFileSync(path.join(fixture.repo, ".gitattributes"), "filtered.txt filter=halltest\n");
    git(["add", "filtered.txt", ".gitattributes"], fixture.repo);
    git(["commit", "-m", "add filtered file"], fixture.repo);
    git(["config", "filter.halltest.smudge", filterCommand], fixture.repo);
    const store = new InMemoryAgentWorktreeStore();
    const runner = new RecordingGitRunner(testGitRunner());
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: runner,
      ownedRoot: makeTempDir("hall owned worktrees "),
      idGenerator: () => "filter-run",
    });

    await expect(
      manager.createWorktree({
        hallTaskId: "task-1",
        hallAgentRunId: "run-1",
        sourceWorkingDirectory: fixture.repo,
      }),
    ).rejects.toMatchObject({ safeFailureCode: "GIT_CHECKOUT_FILTER_UNSUPPORTED" });

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(runner.calls.some((call) => call.args.includes("checkout"))).toBe(false);
    const failed = store.get("filter-run");
    expect(failed.status).toBe("creation_failed");
    expect(failed.safeFailureCode).toBe("GIT_CHECKOUT_FILTER_UNSUPPORTED");
    expect(failed.safeFailureSummary).not.toContain(filterCommand);
    const configCall = runner.calls.find((call) => call.args.includes("--get-regexp"));
    expect(configCall?.cwd).toBe(failed.canonicalWorktreePath);
  });

  it("accepts a real repository-scoped standard Git LFS profile, checks out normally, and never materializes the LFS object", async () => {
    if (!hasGitLfs()) return undefined;
    const fixture = createFixtureRepository("lfs repo");
    git(["lfs", "install", "--local"], fixture.repo);
    fs.writeFileSync(
      path.join(fixture.repo, ".gitattributes"),
      "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
    const lfsContent = "real-binary-content-that-must-not-be-materialized-by-hall\n";
    fs.writeFileSync(path.join(fixture.repo, "asset.bin"), lfsContent);
    git(["add", ".gitattributes", "asset.bin"], fixture.repo);
    git(["commit", "-m", "add lfs asset"], fixture.repo);
    const ownedRoot = makeTempDir("hall owned worktrees ");
    const runner = new RecordingGitRunner(testGitRunner());
    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: runner,
      ownedRoot,
      idGenerator: () => "lfs-run",
    });

    const created = await manager.createWorktree({
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      sourceWorkingDirectory: fixture.repo,
    });

    expect(created.record.status).toBe("ready");
    const ordinaryFile = fs.readFileSync(
      path.join(created.record.canonicalWorktreePath, "README.md"),
      "utf8",
    );
    expect(ordinaryFile).toBe("hello\n");
    const checkedOutAsset = fs.readFileSync(
      path.join(created.record.canonicalWorktreePath, "asset.bin"),
      "utf8",
    );
    expect(checkedOutAsset).not.toBe(lfsContent);
    expect(checkedOutAsset.startsWith("version https://git-lfs.github.com/spec/v1")).toBe(true);

    const checkoutCall = runner.calls.find((call) => call.args.includes("checkout"));
    expect(checkoutCall?.envOverrides).toEqual({ GIT_LFS_SKIP_SMUDGE: "1" });
    const otherCalls = runner.calls.filter((call) => call !== checkoutCall);
    expect(otherCalls.every((call) => call.envOverrides === undefined)).toBe(true);
  }, 60000);

  it("scopes the recognized-LFS skip-smudge override to only the checkout invocation", async () => {
    const source = makeTempDir("fake lfs source ");
    const ownedRoot = makeTempDir("fake lfs owned ");
    const baseCommit = "e".repeat(40);
    const expectedWorktreePath = path.join(ownedRoot, "wt_lfs-scripted-run");
    const runner = new ScriptedGitRunner(
      [
        ok(source),
        ok(""),
        ok(baseCommit),
        ok(""),
        ok(porcelainZ([expectedWorktreePath])),
        ok(
          [
            "filter.lfs.clean\ngit-lfs clean -- %f",
            "filter.lfs.smudge\ngit-lfs smudge -- %f",
            "filter.lfs.process\ngit-lfs filter-process",
            "filter.lfs.required\ntrue",
          ].join("\0") + "\0",
        ),
        ok(""),
        ok(baseCommit),
        exit(1, "", ""),
      ],
      (call) => {
        if (call.args.includes("worktree") && call.args.includes("add")) {
          fs.mkdirSync(expectedWorktreePath, { recursive: true });
        }
      },
    );
    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: runner,
      ownedRoot,
      idGenerator: () => "lfs-scripted-run",
      now: () => BASE_NOW,
    });

    const created = await manager.createWorktree({
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      sourceWorkingDirectory: source,
    });

    expect(created.record.status).toBe("ready");
    const configCall = runner.calls.find((call) => call.args.includes("--get-regexp"));
    expect(configCall?.args).toContain("--null");
    expect(configCall?.envOverrides).toBeUndefined();
    const checkoutCall = runner.calls.find((call) => call.args.includes("checkout"));
    expect(checkoutCall?.envOverrides).toEqual({ GIT_LFS_SKIP_SMUDGE: "1" });
    const rest = runner.calls.filter((call) => call !== checkoutCall);
    expect(rest.every((call) => call.envOverrides === undefined)).toBe(true);
  });

  it("remains safely recoverable after a creation failure caused by an unsupported checkout filter", async () => {
    const fixture = createFixtureRepository("recoverable filter repo");
    fs.writeFileSync(path.join(fixture.repo, "filtered.txt"), "filtered\n");
    fs.writeFileSync(path.join(fixture.repo, ".gitattributes"), "filtered.txt filter=halltest\n");
    git(["add", "filtered.txt", ".gitattributes"], fixture.repo);
    git(["commit", "-m", "add filtered file"], fixture.repo);
    git(["config", "filter.halltest.smudge", "true"], fixture.repo);
    const store = new InMemoryAgentWorktreeStore();
    const ownedRoot = makeTempDir("hall owned worktrees ");
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: testGitRunner(),
      ownedRoot,
      idGenerator: () => "recoverable-filter-run",
    });

    await expect(
      manager.createWorktree({
        hallTaskId: "task-1",
        hallAgentRunId: "run-1",
        sourceWorkingDirectory: fixture.repo,
      }),
    ).rejects.toMatchObject({ safeFailureCode: "GIT_CHECKOUT_FILTER_UNSUPPORTED" });

    const failed = store.get("recoverable-filter-run");
    expect(failed.status).toBe("creation_failed");

    // Reconstructed from the durable record and Hall-owned root, exactly as restart
    // reconciliation does — cleanup never re-runs the filter check (that only ever gates
    // creation), so a worktree that failed before checkout because of an unsupported filter must
    // still be cleanable through the ordinary cleanup path.
    const cleaned = await manager.cleanupWorktree(failed.worktreeId);
    expect(cleaned.status).toBe("cleaned");
    expect(fs.existsSync(failed.canonicalWorktreePath)).toBe(false);
    expect(
      await manager.listRegisteredWorktreePaths(fixture.repo).then((paths) => paths.length),
    ).toBe(1); // only the primary checkout remains registered
    expect(sourceState(fixture.repo).status).toBe("");
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
      gitRunner: testGitRunner(),
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
      gitRunner: testGitRunner(),
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
      gitRunner: testGitRunner(),
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
      "-c",
      "core.fsmonitor=false",
      "worktree",
      "add",
      "--detach",
      "--no-checkout",
      path.join(
        fs.realpathSync.native(path.dirname(store.get("fake-run").canonicalWorktreePath)),
        "wt_fake-run",
      ),
      "a".repeat(40),
    ]);
  });

  it("uses the safe structured no-checkout, filter-inspection, and checkout sequence", async () => {
    const source = makeTempDir("fake source repo ");
    const ownedRoot = makeTempDir("fake owned root ");
    const baseCommit = "b".repeat(40);
    const expectedWorktreePath = path.join(ownedRoot, "wt_structured-run");
    const expectedHooksDirectory = path.join(ownedRoot, "_hall_empty_hooks");
    const runner = new ScriptedGitRunner(
      [
        ok(source),
        ok(""),
        ok(baseCommit),
        ok(""),
        ok(porcelainZ([source, expectedWorktreePath])),
        exit(1, "", ""),
        ok(""),
        ok(baseCommit),
        exit(1, "", ""),
      ],
      (call) => {
        if (call.args.includes("worktree") && call.args.includes("add")) {
          fs.mkdirSync(expectedWorktreePath, { recursive: true });
        }
      },
    );
    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: runner,
      ownedRoot,
      idGenerator: () => "structured-run",
      now: () => BASE_NOW,
    });

    const created = await manager.createWorktree({
      hallTaskId: "task $(cannot-split)",
      hallAgentRunId: "run-1",
      sourceWorkingDirectory: source,
    });

    expect(created.record.status).toBe("ready");
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
      ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all"],
      ["-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD^{commit}"],
      [
        "-c",
        "core.fsmonitor=false",
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        expectedWorktreePath,
        baseCommit,
      ],
      ["-c", "core.fsmonitor=false", "worktree", "list", "--porcelain", "-z"],
      ["-c", "core.fsmonitor=false", "config", "--null", "--get-regexp", "^filter\\..*\\."],
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${fs.realpathSync.native(expectedHooksDirectory)}`,
        "checkout",
        "--detach",
        "--force",
        baseCommit,
      ],
      ["-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD^{commit}"],
      ["-c", "core.fsmonitor=false", "symbolic-ref", "-q", "--short", "HEAD"],
    ]);
    expect(
      runner.calls.flatMap((call) => call.args).some((arg) => arg.includes("$(cannot-split)")),
    ).toBe(false);
  });

  it("accepts Git config exit code 1 with empty output as no checkout filters", async () => {
    const source = makeTempDir("fake no filter source ");
    const ownedRoot = makeTempDir("fake no filter owned ");
    const baseCommit = "c".repeat(40);
    const expectedWorktreePath = path.join(ownedRoot, "wt_no-filter-run");
    const runner = new ScriptedGitRunner(
      [
        ok(source),
        ok(""),
        ok(baseCommit),
        ok(""),
        ok(porcelainZ([expectedWorktreePath])),
        exit(1, "", ""),
        ok(""),
        ok(baseCommit),
        exit(1, "", ""),
      ],
      (call) => {
        if (call.args.includes("worktree") && call.args.includes("add")) {
          fs.mkdirSync(expectedWorktreePath, { recursive: true });
        }
      },
    );
    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: runner,
      ownedRoot,
      idGenerator: () => "no-filter-run",
    });

    await expect(
      manager.createWorktree({
        hallTaskId: "task-1",
        hallAgentRunId: "run-1",
        sourceWorkingDirectory: source,
      }),
    ).resolves.toMatchObject({ record: { status: "ready" } });
  });

  it("rejects ready-worktree validation when the worktree directory is replaced by a symlink", async () => {
    const fixture = createFixtureRepository("validate symlink repo");
    const ownedRoot = makeTempDir("hall owned worktrees ");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: testGitRunner(),
      ownedRoot,
      idGenerator: () => "validate-symlink",
    });
    const created = await manager.createWorktree({
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      sourceWorkingDirectory: fixture.repo,
    });
    const originalSibling = path.join(ownedRoot, "validate-original");
    fs.renameSync(created.record.canonicalWorktreePath, originalSibling);
    const outside = makeTempDir("outside validate target ");
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "do not touch\n");
    try {
      fs.symlinkSync(outside, created.record.canonicalWorktreePath, "dir");
    } catch {
      return undefined;
    }
    const runner = new RecordingGitRunner(testGitRunner());
    const validationManager = new AgentWorktreeManager({ store, gitRunner: runner, ownedRoot });

    await expect(
      validationManager.validateReadyWorktree({
        worktreeId: created.record.worktreeId,
        hallTaskId: "task-1",
        hallAgentRunId: "run-1",
        sourceWorkingDirectory: fixture.repo,
        requireHeadAtBase: true,
      }),
    ).rejects.toThrow(AgentWorktreePathError);
    expect(runner.calls).toHaveLength(0);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("do not touch\n");
    expect(fs.existsSync(originalSibling)).toBe(true);
  });

  it("treats a malformed effective filter config query as a safe creation failure", async () => {
    const source = makeTempDir("fake filter query source ");
    const ownedRoot = makeTempDir("fake filter query owned ");
    const baseCommit = "d".repeat(40);
    const expectedWorktreePath = path.join(ownedRoot, "wt_filter-query-fail");
    const store = new InMemoryAgentWorktreeStore();
    const runner = new ScriptedGitRunner(
      [
        ok(source),
        ok(""),
        ok(baseCommit),
        ok(""),
        ok(porcelainZ([expectedWorktreePath])),
        exit(2, "", "bad config"),
      ],
      (call) => {
        if (call.args.includes("worktree") && call.args.includes("add")) {
          fs.mkdirSync(expectedWorktreePath, { recursive: true });
        }
      },
    );
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: runner,
      ownedRoot,
      idGenerator: () => "filter-query-fail",
    });

    await expect(
      manager.createWorktree({
        hallTaskId: "task-1",
        hallAgentRunId: "run-1",
        sourceWorkingDirectory: source,
      }),
    ).rejects.toMatchObject({ safeFailureCode: "GIT_FILTER_CONFIG_INSPECTION_FAILED" });
    expect(store.get("filter-query-fail").status).toBe("creation_failed");
    expect(runner.calls.some((call) => call.args.includes("checkout"))).toBe(false);
  });

  it("cleans up a valid registered worktree by id without mutating the source checkout", async () => {
    const fixture = createFixtureRepository("cleanup repo");
    const ownedRoot = makeTempDir("hall owned worktrees ");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: testGitRunner(),
      ownedRoot,
      idGenerator: () => "cleanup-run",
    });
    const created = await manager.createWorktree({
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      sourceWorkingDirectory: fixture.repo,
    });
    const sibling = path.join(ownedRoot, "unrelated-sibling");
    fs.mkdirSync(sibling);
    const before = sourceState(fixture.repo);
    const cleaned = await manager.cleanupWorktree(created.record.worktreeId);
    expect(cleaned.status).toBe("cleaned");
    expect(fs.existsSync(created.record.canonicalWorktreePath)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(sourceState(fixture.repo)).toEqual(before);
  });

  it("rejects cleanup when the worktree directory is replaced by a symlink to outside", async () => {
    const fixture = createFixtureRepository("cleanup symlink repo");
    const ownedRoot = makeTempDir("hall owned worktrees ");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: testGitRunner(),
      ownedRoot,
      idGenerator: () => "cleanup-symlink",
    });
    const created = await manager.createWorktree({
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      sourceWorkingDirectory: fixture.repo,
    });
    const originalSibling = path.join(ownedRoot, "original-sibling");
    fs.renameSync(created.record.canonicalWorktreePath, originalSibling);
    const outside = makeTempDir("outside cleanup target ");
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "do not touch\n");
    try {
      fs.symlinkSync(outside, created.record.canonicalWorktreePath, "dir");
    } catch {
      return undefined;
    }
    const runner = new RecordingGitRunner(testGitRunner());
    const cleanupManager = new AgentWorktreeManager({ store, gitRunner: runner, ownedRoot });

    await expect(cleanupManager.cleanupWorktree(created.record.worktreeId)).rejects.toThrow(
      AgentWorktreePathError,
    );
    expect(store.get(created.record.worktreeId).status).toBe("ready");
    expect(runner.calls).toHaveLength(0);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("do not touch\n");
    expect(fs.existsSync(originalSibling)).toBe(true);
  });

  it("rejects cleanup when a Windows junction redirects the worktree outside", async () => {
    if (process.platform !== "win32") {
      return undefined;
    }
    const fixture = createFixtureRepository("cleanup junction repo");
    const ownedRoot = makeTempDir("hall owned worktrees ");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: testGitRunner(),
      ownedRoot,
      idGenerator: () => "cleanup-junction",
    });
    const created = await manager.createWorktree({
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      sourceWorkingDirectory: fixture.repo,
    });
    fs.renameSync(created.record.canonicalWorktreePath, path.join(ownedRoot, "junction-original"));
    const outside = makeTempDir("outside cleanup junction target ");
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "do not touch\n");
    try {
      fs.symlinkSync(outside, created.record.canonicalWorktreePath, "junction");
    } catch {
      return undefined;
    }
    const runner = new RecordingGitRunner(testGitRunner());
    const cleanupManager = new AgentWorktreeManager({ store, gitRunner: runner, ownedRoot });

    await expect(cleanupManager.cleanupWorktree(created.record.worktreeId)).rejects.toThrow(
      AgentWorktreePathError,
    );
    expect(store.get(created.record.worktreeId).status).toBe("ready");
    expect(runner.calls).toHaveLength(0);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("do not touch\n");
  });

  it("rejects a tampered persisted cleanup path before requesting cleanup", async () => {
    const source = makeTempDir("cleanup tampered source ");
    const ownedRoot = makeTempDir("cleanup tampered owned ");
    const store = new InMemoryAgentWorktreeStore();
    store.createCreating({
      worktreeId: "tampered",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      canonicalSourceRepositoryRoot: source,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: "a".repeat(40),
      canonicalWorktreePath: path.join(ownedRoot, "wt_other"),
      createdAt: BASE_NOW,
    });
    store.markReady({ worktreeId: "tampered", expectedRevision: 0, readyAt: BASE_NOW });
    const runner = new ScriptedGitRunner([]);
    const manager = new AgentWorktreeManager({ store, gitRunner: runner, ownedRoot });

    await expect(manager.cleanupWorktree("tampered")).rejects.toThrow(AgentWorktreePathError);
    expect(store.get("tampered").status).toBe("ready");
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a prefix-confusion cleanup sibling before Git removal", async () => {
    const source = makeTempDir("cleanup prefix source ");
    const base = makeTempDir("cleanup prefix base ");
    const ownedRoot = path.join(base, "owned");
    const siblingRoot = path.join(base, "owned-sibling");
    fs.mkdirSync(siblingRoot, { recursive: true });
    const store = new InMemoryAgentWorktreeStore();
    store.createCreating({
      worktreeId: "prefix",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      canonicalSourceRepositoryRoot: source,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: "a".repeat(40),
      canonicalWorktreePath: path.join(siblingRoot, "wt_prefix"),
      createdAt: BASE_NOW,
    });
    store.markReady({ worktreeId: "prefix", expectedRevision: 0, readyAt: BASE_NOW });
    const runner = new ScriptedGitRunner([]);
    const manager = new AgentWorktreeManager({ store, gitRunner: runner, ownedRoot });

    await expect(manager.cleanupWorktree("prefix")).rejects.toThrow(AgentWorktreePathError);
    expect(store.get("prefix").status).toBe("ready");
    expect(runner.calls).toHaveLength(0);
  });

  it("handles an already-missing unregistered worktree idempotently", async () => {
    const fixture = createFixtureRepository("missing cleanup repo");
    const store = new InMemoryAgentWorktreeStore();
    const manager = new AgentWorktreeManager({
      store,
      gitRunner: testGitRunner(),
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
    const runner = new ScriptedGitRunner([ok(porcelainZ([worktreePath])), fail("locked file")]);
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

describe("listRegisteredWorktreePaths (post-merge Phase 16.5 hardening)", () => {
  it("lists the primary checkout via a real Git invocation", async () => {
    const fixture = createFixtureRepository("registration list primary");
    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: testGitRunner(),
      ownedRoot: makeTempDir("hall owned worktrees "),
    });
    const paths = await manager.listRegisteredWorktreePaths(fixture.repo);
    expect(paths).toContainEqual(fixture.repo);
  });

  it("lists multiple real worktrees, including paths with spaces and non-ASCII characters", async () => {
    const fixture = createFixtureRepository("registration list multiple");
    const ownedRoot = makeTempDir("hall owned worktrees ");
    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: testGitRunner(),
      ownedRoot,
      idGenerator: idSequence(["with-spaces", "unicode"]),
    });

    const withSpaces = path.join(ownedRoot, "wt_with-spaces extra");
    git(["worktree", "add", "--detach", "--no-checkout", withSpaces, fixture.head], fixture.repo);
    const nonAscii = path.join(ownedRoot, "wt_ünïcödé-日本語");
    git(["worktree", "add", "--detach", "--no-checkout", nonAscii, fixture.head], fixture.repo);

    const paths = await manager.listRegisteredWorktreePaths(fixture.repo);
    expect(paths).toContainEqual(fixture.repo);
    expect(paths).toContainEqual(fs.realpathSync.native(withSpaces));
    expect(paths).toContainEqual(fs.realpathSync.native(nonAscii));
  });

  it("fails closed on truncated Git worktree-list output rather than returning a partial list", async () => {
    const sourceRepositoryRoot = path.resolve(path.sep, "repo");
    const runner = new ScriptedGitRunner([
      {
        exitCode: 0,
        signal: null,
        stdout: `worktree ${sourceRepositoryRoot}\0`,
        stderr: "",
        stdoutTruncated: true,
        timedOut: false,
        spawnError: undefined,
      },
    ]);
    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: runner,
      ownedRoot: makeTempDir("hall owned worktrees "),
    });
    await expect(manager.listRegisteredWorktreePaths(sourceRepositoryRoot)).rejects.toMatchObject({
      safeFailureCode: "GIT_WORKTREE_LIST_TRUNCATED",
    });
  });

  it("fails closed on exit-code-zero output that is not valid porcelain -z structure, never returning zero registrations silently", async () => {
    const runner = new ScriptedGitRunner([ok("this is not valid porcelain -z output at all")]);
    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: runner,
      ownedRoot: makeTempDir("hall owned worktrees "),
    });
    await expect(
      manager.listRegisteredWorktreePaths(path.resolve(path.sep, "repo")),
    ).rejects.toMatchObject({
      safeFailureCode: "GIT_WORKTREE_LIST_MALFORMED",
    });
  });

  it("fails closed on exit-code-zero EMPTY output — never interpreted as proof that no registrations exist", async () => {
    const runner = new ScriptedGitRunner([ok("")]);
    const manager = new AgentWorktreeManager({
      store: new InMemoryAgentWorktreeStore(),
      gitRunner: runner,
      ownedRoot: makeTempDir("hall owned worktrees "),
    });
    await expect(
      manager.listRegisteredWorktreePaths(path.resolve(path.sep, "repo")),
    ).rejects.toMatchObject({
      safeFailureCode: "GIT_WORKTREE_LIST_MALFORMED",
    });
  });
});

describe("cleanupWorktree (post-merge Phase 16.5 hardening — empty registration output)", () => {
  it("does not mark a missing worktree cleaned when Git registration inspection returns empty malformed output", async () => {
    const ownedRoot = makeTempDir("hall owned worktrees ");
    const sourceRepo = makeTempDir("fake source repo ");
    const missingWorktreePath = path.join(ownedRoot, "wt_missing-empty-output");
    // Deliberately never created on disk — `pathExists` must resolve to
    // `false`, the exact precondition the original defect required.
    const store = new InMemoryAgentWorktreeStore();
    const creating = store.createCreating({
      worktreeId: "missing-empty-output",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      canonicalSourceRepositoryRoot: sourceRepo,
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: "a".repeat(40),
      canonicalWorktreePath: missingWorktreePath,
      createdAt: BASE_NOW,
    });
    store.markReady({
      worktreeId: "missing-empty-output",
      expectedRevision: creating.revision,
      readyAt: BASE_NOW,
    });
    const runner = new ScriptedGitRunner([ok("")]);
    const manager = new AgentWorktreeManager({ store, gitRunner: runner, ownedRoot });

    await expect(manager.cleanupWorktree("missing-empty-output")).rejects.toMatchObject({
      safeFailureCode: "GIT_WORKTREE_LIST_MALFORMED",
    });
    // The whole point of this test: a missing path plus malformed (empty)
    // registration output must never be read as "not registered either,
    // therefore already cleaned" — it must fail closed instead, leaving
    // the record exactly where cleanup left it (never `cleaned`).
    expect(store.get("missing-empty-output").status).not.toBe("cleaned");
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

let cachedHasGitLfs: boolean | undefined;
/** Real `git-lfs` may not be installed on every machine that runs this suite — the real end-to-end
 * LFS test skips itself (rather than failing) when it isn't, the same tolerant pattern this file
 * already uses for `installExecutablePostCheckoutHook`'s permission-dependent skip. */
function hasGitLfs(): boolean {
  if (cachedHasGitLfs !== undefined) return cachedHasGitLfs;
  try {
    execFileSync("git", ["lfs", "version"], { stdio: "ignore" });
    cachedHasGitLfs = true;
  } catch {
    cachedHasGitLfs = false;
  }
  return cachedHasGitLfs;
}

function testGitRunner(): NodeGitCommandRunner {
  const home = makeTempDir("hall isolated git home ");
  return new NodeGitCommandRunner({
    parentEnv: {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      COMSPEC: process.env.COMSPEC,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
    },
    spawner: {
      spawn(executablePath, args, options) {
        return nodeGitProcessSpawner.spawn(executablePath, args, {
          ...options,
          env: { ...options.env, GIT_CONFIG_NOSYSTEM: "1" },
        });
      },
    },
  });
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

function installExecutablePostCheckoutHook(repo: string, sentinel: string): boolean {
  const hooksPath = git(["rev-parse", "--git-path", "hooks"], repo);
  const hooksDirectory = path.isAbsolute(hooksPath) ? hooksPath : path.join(repo, hooksPath);
  fs.mkdirSync(hooksDirectory, { recursive: true });
  const hookPath = path.join(hooksDirectory, "post-checkout");
  fs.writeFileSync(
    hookPath,
    `#!/bin/sh\nprintf hooked > ${shellQuote(toGitShellPath(sentinel))}\n`,
  );
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    return false;
  }

  try {
    git(["checkout", "-b", "hook-probe"], repo);
    const executed = fs.existsSync(sentinel);
    if (fs.existsSync(sentinel)) fs.rmSync(sentinel, { force: true });
    git(["checkout", "main"], repo);
    if (fs.existsSync(sentinel)) fs.rmSync(sentinel, { force: true });
    git(["branch", "-D", "hook-probe"], repo);
    return executed;
  } catch {
    return false;
  }
}

function toGitShellPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

function exit(exitCode: number, stdout: string, stderr: string): GitCommandResult {
  return { exitCode, signal: null, stdout, stderr, timedOut: false, spawnError: undefined };
}

/**
 * Builds valid `git worktree list --porcelain -z` output for one worktree
 * per path, matching the real NUL-delimited byte structure
 * `worktree-list-parser.ts` requires — see that module's doc comment. Every
 * worktree `AgentWorktreeManager.createWorktree` creates is always detached
 * (`git worktree add --detach`), so each record includes `HEAD`/`detached`
 * — the exact attribute set the strict parser now requires for a
 * structurally complete, non-bare record — rather than the minimal
 * `worktree <path>` line alone, which the parser correctly rejects.
 */
function porcelainZ(paths: readonly string[]): string {
  const sampleHead = "a".repeat(40);
  return paths
    .map((worktreePath) => `worktree ${worktreePath}\0HEAD ${sampleHead}\0detached\0\0`)
    .join("");
}

type GitRunnerCall = Parameters<GitCommandRunner["run"]>[0];

class RecordingGitRunner implements GitCommandRunner {
  readonly calls: GitRunnerCall[] = [];
  readonly #inner: GitCommandRunner;

  constructor(inner: GitCommandRunner) {
    this.#inner = inner;
  }

  async run(input: GitRunnerCall): Promise<GitCommandResult> {
    this.calls.push(input);
    return this.#inner.run(input);
  }
}

class ScriptedGitRunner implements GitCommandRunner {
  readonly calls: GitRunnerCall[] = [];
  readonly #results: GitCommandResult[];
  readonly #onRun: ((input: GitRunnerCall) => void) | undefined;

  constructor(results: GitCommandResult[], onRun?: (input: GitRunnerCall) => void) {
    this.#results = [...results];
    this.#onRun = onRun;
  }

  run(input: GitRunnerCall): Promise<GitCommandResult> {
    this.calls.push(input);
    this.#onRun?.(input);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("No scripted Git result");
    return Promise.resolve(result);
  }
}
