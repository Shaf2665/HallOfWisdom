import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHallCoreApp,
  createComparisonComposition,
  TaskOrchestrator,
  TaskStore,
  EventStore,
  EventBus,
  BoardStore,
  MessageStore,
  MessageBus,
  DEFAULT_LIMITS,
  LOCAL_ONLY_HOST,
  type ComparisonComposition,
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
 * package entry (`createHallCoreApp`, `TaskOrchestrator`, `TaskStore`,
 * ...) — the exact same building blocks any other external consumer of
 * that package would use — plus this package's own deterministic fixture
 * adapters (`fixture-adapters.ts`) instead of real
 * Claude-Code/Codex-spawning ones. This is what "a test-only Hall Core
 * composition launched by the Playwright suite" (Phase 11.1) means
 * concretely: a separate script, not a flag on the real server.
 *
 * Binds to `127.0.0.1` only, exactly like the real server
 * (`LOCAL_ONLY_HOST`) — never reachable from the network.
 */
async function main(): Promise<void> {
  const port = Number(process.env.HALL_CORE_E2E_PORT ?? "4310");
  const webOrigin = process.env.HALL_CORE_E2E_WEB_ORIGIN ?? "http://127.0.0.1:3000";
  const workspaceRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "hall-e2e-workspace-")),
  );
  initFixtureWorkspace(workspaceRoot);
  const comparisonRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "hall-e2e-comparison-root-")),
  );

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

  const taskStore = new TaskStore({ maxTasks: limits.maxTasks });
  const eventStore = new EventStore({ maxEventsPerTask: limits.maxEventsPerTask });
  const eventBus = new EventBus({ maxSubscribersPerTask: limits.maxSubscribersPerTask });

  const orchestrator = new TaskOrchestrator({
    taskStore,
    eventStore,
    eventBus,
    registry,
    workspaceRoot,
    onExecutionError: (taskId, error) => {
      console.error(`[e2e fixture server] task ${taskId} execution failed:`, error);
    },
  });

  const boardStore = new BoardStore({ maxBoards: limits.maxBoards, taskStore });
  const messageStore = new MessageStore({ maxMessagesPerBoard: limits.maxMessagesPerBoard });
  const messageBus = new MessageBus({ maxSubscribersPerBoard: limits.maxSubscribersPerBoard });
  const generalBoard = boardStore.seedGeneralBoard(new Date().toISOString());
  messageStore.registerBoard(generalBoard.boardId);

  const comparison: ComparisonComposition = createComparisonComposition({
    registry,
    taskStore,
    workspaceRoot,
    comparisonRoot,
    limits,
    onExecutionError: (candidateId, error) => {
      console.error(
        `[e2e fixture server] comparison candidate ${candidateId} execution failed:`,
        error,
      );
    },
  });

  const app = await createHallCoreApp({
    orchestrator,
    taskStore,
    eventStore,
    eventBus,
    boardStore,
    messageStore,
    messageBus,
    registry,
    comparison,
    webOrigin,
    limits,
  });

  await app.listen({ port, host: LOCAL_ONLY_HOST });
  console.log(
    `[e2e fixture server] listening on http://${LOCAL_ONLY_HOST}:${String(port)} (webOrigin=${webOrigin}, workspaceRoot=${workspaceRoot}, comparisonRoot=${comparisonRoot})`,
  );

  const shutdown = (): void => {
    void (async () => {
      await orchestrator.shutdown(2000);
      await comparison.comparisonOrchestrator.shutdown(2000);
      await app.close();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(comparisonRoot, { recursive: true, force: true });
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error("[e2e fixture server] failed to start:", error);
  process.exitCode = 1;
});
