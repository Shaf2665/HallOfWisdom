import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createHallCoreApp,
  createComparisonComposition,
  createCoreStoresComposition,
  resolveDataDir,
  openDurableStorage,
  startOwnershipFenceMonitor,
  installShutdownSignals,
  recordCleanShutdown,
  DEFAULT_LIMITS,
  LOCAL_ONLY_HOST,
  DATABASE_BUSY_TIMEOUT_MS,
  type ComparisonComposition,
  type HallDatabase,
  type OwnershipFenceMonitorHandle,
} from "@hall-of-wisdom/hall-core";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { createAllFixtureAdapters, createFixtureComparisonAdapter } from "./fixture-adapters.js";
import { E2E_SOURCE_REPO_RELATIVE_DIR } from "./fixture-constants.js";

function git(args: readonly string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
}

function initGitRepo(repoPath: string, readmeContent: string): void {
  git(["init", "--quiet"], repoPath);
  git(["config", "user.email", "hall-of-wisdom-e2e@example.com"], repoPath);
  git(["config", "user.name", "Hall of Wisdom E2E"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), readmeContent);
  git(["add", "README.md"], repoPath);
  git(["commit", "--quiet", "-m", "initial commit"], repoPath);
}

/**
 * Phase 12.1 — reproduces the exact real-world finding a genuine Claude
 * Code/Codex comparison run surfaced: `workspaceRoot` is a trusted
 * *security boundary*, not itself the source repository. `workspaceRoot`
 * here is deliberately: (1) its own Git repository, and (2) left DIRTY
 * (an uncommitted file) — simulating an operator's real, in-progress
 * development work sitting alongside the workspace, exactly like Hall of
 * Wisdom's own uncommitted Phase 12 work sat alongside the fixture
 * repository during the real comparison run. A separate, independent,
 * CLEAN Git repository is nested at `E2E_SOURCE_REPO_RELATIVE_DIR` — this
 * is what a comparison task's `workingDirectory` actually points at, and
 * comparison preparation must succeed despite `workspaceRoot` itself being
 * dirty, using only the nested repository's own commit/cleanliness.
 */
function initFixtureWorkspace(workspaceRoot: string): void {
  initGitRepo(workspaceRoot, "Hall of Wisdom E2E fixture workspace\n");
  fs.writeFileSync(
    path.join(workspaceRoot, "unrelated-dirty-file.txt"),
    "Uncommitted, unrelated change — must never block or affect a comparison.\n",
  );

  const sourceRepoPath = path.join(workspaceRoot, E2E_SOURCE_REPO_RELATIVE_DIR);
  fs.mkdirSync(sourceRepoPath);
  initGitRepo(sourceRepoPath, "Hall of Wisdom E2E nested source repository\n");
}

/**
 * A standalone Hall Core process for Playwright E2E verification only —
 * never imported by `server.ts` or any real composition path
 * (`server-composition.ts`), and never reachable through any production
 * CLI flag. Built entirely from `@hall-of-wisdom/hall-core`'s own public
 * package entry (`createHallCoreApp`, `createCoreStoresComposition`,
 * `openDurableStorage`, ...) — the exact same building blocks any other
 * external consumer of that package would use — plus this package's own
 * deterministic fixture adapters (`fixture-adapters.ts`) instead of real
 * Claude-Code/Codex-spawning ones. This is what "a test-only Hall Core
 * composition launched by the Playwright suite" means concretely: a
 * separate script, not a flag on the real server.
 *
 * Binds to `127.0.0.1` only, exactly like the real server
 * (`LOCAL_ONLY_HOST`) — never reachable from the network.
 *
 * Phase 13.2 — optionally durable, controlled entirely by environment
 * variables the E2E harness sets (never a CLI flag, never anything a
 * production deployment could stumble into):
 *   HALL_CORE_E2E_DATA_DIR         — when set, durable mode via the exact
 *                                    same `openDurableStorage` +
 *                                    `createCoreStoresComposition` +
 *                                    ownership-fence-monitor +
 *                                    controlled-shutdown sequence
 *                                    `server.ts` uses (see
 *                                    `durable-startup.ts`'s doc comment) —
 *                                    never a reimplementation.
 *   HALL_CORE_E2E_WORKSPACE_ROOT,
 *   HALL_CORE_E2E_COMPARISON_ROOT  — when set, reused across restarts
 *                                    instead of a fresh temp directory;
 *                                    the workspace is only initialized
 *                                    (git init, nested source repo) the
 *                                    first time — a second boot against an
 *                                    already-initialized workspace reuses
 *                                    it as-is, exactly like a real restart
 *                                    reusing its `--workspace-root`.
 * When any of these is set, this process never deletes the directories it
 * was given on shutdown — cleanup across a restart is the harness's job
 * (see `durable-restart-harness.ts`), not this process's.
 */
async function main(): Promise<void> {
  const port = Number(process.env.HALL_CORE_E2E_PORT ?? "4310");
  const webOrigin = process.env.HALL_CORE_E2E_WEB_ORIGIN ?? "http://127.0.0.1:3000";
  const dataDir = process.env.HALL_CORE_E2E_DATA_DIR;
  const durable = dataDir !== undefined;

  // Canonicalized via `fs.realpathSync.native` regardless of source
  // (freshly created or externally supplied by the harness) — an
  // externally-supplied path (e.g. built from `os.tmpdir()` in the
  // *harness's own* process) can resolve to a different string form
  // (short 8.3 vs. long form on Windows) than what `GitWorktreeManager`'s
  // own containment checks compare against internally, which would
  // otherwise fail a genuinely-contained worktree path as a
  // `WorktreeContainmentViolationError` purely from string mismatch, not
  // any real escape.
  const externalWorkspaceRoot = process.env.HALL_CORE_E2E_WORKSPACE_ROOT;
  if (externalWorkspaceRoot !== undefined) {
    fs.mkdirSync(externalWorkspaceRoot, { recursive: true });
  }
  const workspaceRoot = fs.realpathSync.native(
    externalWorkspaceRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "hall-e2e-workspace-")),
  );
  if (!fs.existsSync(path.join(workspaceRoot, ".git"))) {
    initFixtureWorkspace(workspaceRoot);
  }

  const externalComparisonRoot = process.env.HALL_CORE_E2E_COMPARISON_ROOT;
  if (externalComparisonRoot !== undefined) {
    fs.mkdirSync(externalComparisonRoot, { recursive: true });
  }
  const comparisonRoot = fs.realpathSync.native(
    externalComparisonRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "hall-e2e-comparison-root-")),
  );
  fs.mkdirSync(comparisonRoot, { recursive: true });

  const limits = DEFAULT_LIMITS;
  const registry = new AgentRegistry();
  for (const adapter of createAllFixtureAdapters()) {
    registry.register(adapter);
  }
  registry.register(
    createFixtureComparisonAdapter({
      adapterId: "hall.e2e-comparison-a",
      displayName: "E2E Comparison Adapter A",
      fileName: "candidate-a-output.txt",
      fileContent: "output from candidate A\n",
    }),
  );
  registry.register(
    createFixtureComparisonAdapter({
      adapterId: "hall.e2e-comparison-b",
      displayName: "E2E Comparison Adapter B",
      fileName: "candidate-b-output.txt",
      fileContent: "output from candidate B\n",
    }),
  );

  let db: HallDatabase | undefined;
  let fenceMonitorHandle: OwnershipFenceMonitorHandle | undefined;
  const bootId = randomUUID();
  let ownershipHandle: { release(): void } | undefined;

  if (durable) {
    const canonicalDataDir = resolveDataDir({ dataDir, workspaceRoot, comparisonRoot });
    const opened = openDurableStorage({
      dataDir: canonicalDataDir,
      bootId,
      busyTimeoutMs: DATABASE_BUSY_TIMEOUT_MS,
    });
    db = opened.db;
    ownershipHandle = opened.ownershipHandle;

    fenceMonitorHandle = startOwnershipFenceMonitor({
      db: opened.db,
      fence: opened.ownershipFence,
      onOwnershipLost: () => {
        console.error(
          "[e2e fixture server] durable ownership superseded by another instance; exiting.",
        );
        process.exit(1);
      },
    });
  }

  const stores = createCoreStoresComposition({
    registry,
    workspaceRoot,
    limits,
    onExecutionError: (taskId, error) => {
      console.error(`[e2e fixture server] task ${taskId} execution failed:`, error);
    },
    db,
  });

  const comparison: ComparisonComposition = createComparisonComposition({
    registry,
    taskStore: stores.taskStore,
    workspaceRoot,
    comparisonRoot,
    limits,
    onExecutionError: (candidateId, error) => {
      console.error(
        `[e2e fixture server] comparison candidate ${candidateId} execution failed:`,
        error,
      );
    },
    db,
  });

  // Minimal rehydration for a durable restart: `ComparisonOrchestrator`
  // keeps candidate worktree/source-repository paths in memory, populated
  // on `prepare()` — a fresh second-boot instance has none of that until
  // told. This calls the exact same rehydration method the real
  // `runRestartRecovery` calls (`restart-recovery.ts`), using the exact
  // same underlying data (`comparisonInternalPaths.listAll()`); it
  // deliberately does not reuse the rest of `runRestartRecovery` (crash
  // reconciliation, worktree health classification, orphan scanning) —
  // this composition's own graceful-stop-then-restart flow never leaves
  // anything genuinely non-terminal, and that reconciliation path is
  // already thoroughly covered by the production-binary
  // `durable-restart.spec.ts` and its module-level test suites.
  if (durable && comparison.comparisonInternalPaths !== undefined) {
    const internalPaths = comparison.comparisonInternalPaths.listAll();
    comparison.comparisonOrchestrator.rehydrateInternalPaths({
      sourceRepositoryPaths: internalPaths.sourceRepositoryPaths,
      worktreePaths: internalPaths.worktreePaths.map(({ candidateId, worktreePath }) => ({
        candidateId,
        worktreePath,
      })),
    });
  }

  const readiness = { ready: true };

  const app = await createHallCoreApp({
    orchestrator: stores.orchestrator,
    taskStore: stores.taskStore,
    eventStore: stores.eventStore,
    eventBus: stores.eventBus,
    boardStore: stores.boardStore,
    messageStore: stores.messageStore,
    messageBus: stores.messageBus,
    registry,
    comparison,
    webOrigin,
    limits,
    storageMode: durable ? "durable" : "in-memory",
    readiness,
  });

  await app.listen({ port, host: LOCAL_ONLY_HOST });
  console.log(
    `[e2e fixture server] listening on http://${LOCAL_ONLY_HOST}:${String(port)} (webOrigin=${webOrigin}, workspaceRoot=${workspaceRoot}, comparisonRoot=${comparisonRoot}, durable=${String(durable)})`,
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    readiness.ready = false;
    fenceMonitorHandle?.stop();
    void (async () => {
      await stores.orchestrator.shutdown(2000);
      await comparison.comparisonOrchestrator.shutdown(2000);
      await app.close();
      if (db !== undefined) {
        try {
          recordCleanShutdown(db, bootId, new Date().toISOString());
        } catch (error) {
          console.error("[e2e fixture server] failed to record clean-shutdown marker:", error);
        }
        db.close();
        ownershipHandle?.release();
      }
      // Only clean up directories this process itself created — an
      // externally-supplied workspace/comparison/data root (durable
      // restart mode) is the harness's to remove, once every boot it
      // orchestrates is done, not this individual boot's.
      if (externalWorkspaceRoot === undefined) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
      }
      if (externalComparisonRoot === undefined) {
        fs.rmSync(comparisonRoot, { recursive: true, force: true });
      }
      process.exit(0);
    })();
  };
  installShutdownSignals({
    onGracefulShutdown: shutdown,
    onForceExit: () => {
      process.exit(1);
    },
  });
}

main().catch((error: unknown) => {
  console.error("[e2e fixture server] failed to start:", error);
  process.exitCode = 1;
});
