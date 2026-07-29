import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHallTask } from "@hall-of-wisdom/protocol";
import { createServerComposition, type ServerComposition } from "./server-composition.js";
import { resolveDataDir } from "../persistence/database-config.js";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { runRestartRecovery } from "../recovery/restart-recovery.js";
import { DEFAULT_LIMITS } from "../config/server-config.js";
import type { TaskRecord } from "../tasks/task-record.js";

/**
 * The end-to-end wiring test the module-level recovery tests cannot cover:
 * this one drives the REAL `createServerComposition`/`createComparisonComposition`
 * roots — the same functions `server.ts` calls — twice against the same
 * `--data-dir`, rather than hand-constructing `SqliteTaskStore`/
 * `SqliteComparisonStore` instances directly. It proves the actual startup
 * wiring (not just the recovery module's own logic) survives a restart,
 * and specifically that `ComparisonOrchestrator.rehydrateInternalPaths()`
 * is load-bearing: without it, a surviving `ready` comparison's worktree
 * paths would be empty after a restart and `cleanupComparison` would
 * silently no-op instead of actually removing anything from disk.
 */

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

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function buildSourceTaskRecord(taskId: string): TaskRecord {
  const now = "2026-01-01T00:00:00.000Z";
  const task = parseHallTask({
    taskId,
    projectId: "hall.comparison-source",
    title: "Source task",
    description: "",
    priority: "normal",
    status: "backlog",
    dependencyTaskIds: [],
    createdAt: now,
    updatedAt: now,
  });
  return {
    task,
    runId: undefined,
    adapterId: undefined,
    agentId: undefined,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: now,
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: undefined,
  };
}

describe("durable restart via the real composition roots", () => {
  let tempRoot: string;
  const openDbs: HallDatabase[] = [];

  afterEach(() => {
    for (const db of openDbs.splice(0)) db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function openDurableComposition(input: {
    readonly workspaceRoot: string;
    readonly comparisonRoot?: string | undefined;
    readonly dataDirRaw: string;
  }): { readonly db: HallDatabase; readonly composition: ServerComposition } {
    const dataDir = resolveDataDir({
      dataDir: input.dataDirRaw,
      workspaceRoot: input.workspaceRoot,
      comparisonRoot: input.comparisonRoot,
    });
    const db = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    runMigrations(db);
    openDbs.push(db);
    const composition = createServerComposition({
      workspaceRoot: input.workspaceRoot,
      mockScenario: "success",
      mockStepDelayMs: 0,
      limits: DEFAULT_LIMITS,
      comparisonRoot: input.comparisonRoot,
      db,
    });
    return { db, composition };
  }

  it("a task's terminal outcome survives a real composition-root restart", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-durable-restart-task-"));
    const workspaceRoot = fs.realpathSync.native(
      (() => {
        const dir = path.join(tempRoot, "workspace");
        fs.mkdirSync(dir);
        return dir;
      })(),
    );
    const dataDirRaw = path.join(tempRoot, "data");

    const first = openDurableComposition({ workspaceRoot, dataDirRaw });
    const created = first.composition.orchestrator.createTask({
      projectId: "proj-1",
      title: "Durable task",
      executionMode: "immediate",
      adapterId: "hall.mock-agent",
    });
    const taskId = created.task.taskId;

    await waitUntil(() => {
      const status = first.composition.taskStore.get(taskId).task.status;
      return status === "completed" || status === "failed";
    });
    expect(first.composition.taskStore.get(taskId).task.status).toBe("completed");
    const eventCountBeforeRestart = first.composition.taskStore.get(taskId).eventCount;
    first.db.close();

    const second = openDurableComposition({ workspaceRoot, dataDirRaw });
    expect(second.composition.taskStore.get(taskId).task.status).toBe("completed");
    expect(second.composition.taskStore.get(taskId).eventCount).toBe(eventCountBeforeRestart);

    const recovery = await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: new Date().toISOString(),
      workspaceRoot,
      comparisonRoot: undefined,
      taskStore: second.composition.taskStore,
      taskEventStore: second.composition.eventStore,
      comparison: undefined,
    });

    expect(recovery.summary.interruptedTaskRunCount).toBe(0);
    expect(recovery.summary.taskEventProjectionsRepaired).toBe(0);
  });

  it("a communication board and its messages survive a real composition-root restart", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-durable-restart-boards-"));
    const workspaceRoot = fs.realpathSync.native(
      (() => {
        const dir = path.join(tempRoot, "workspace");
        fs.mkdirSync(dir);
        return dir;
      })(),
    );
    const dataDirRaw = path.join(tempRoot, "data");

    const first = openDurableComposition({ workspaceRoot, dataDirRaw });
    // `createServerComposition` already seeds the General board.
    const generalBoard = first.composition.boardStore.get("hall.general");
    const message = first.composition.messageStore.append(generalBoard.boardId, {
      messageId: randomUUID(),
      boardId: generalBoard.boardId,
      author: { kind: "human", displayName: "Operator" },
      text: "This message must survive a restart.",
      createdAt: new Date().toISOString(),
    });
    first.composition.boardStore.recordMessageAppended(
      generalBoard.boardId,
      1,
      new Date().toISOString(),
    );
    first.db.close();

    const second = openDurableComposition({ workspaceRoot, dataDirRaw });
    const boardAfterRestart = second.composition.boardStore.get("hall.general");
    expect(boardAfterRestart.messageCount).toBe(1);
    const messagesAfterRestart = second.composition.messageStore.list(generalBoard.boardId);
    expect(messagesAfterRestart).toHaveLength(1);
    expect(messagesAfterRestart[0]?.messageId).toBe(message.messageId);
    expect(messagesAfterRestart[0]?.text).toBe("This message must survive a restart.");
  });

  it("a ready comparison's worktrees survive a restart, and rehydration lets cleanup actually remove them from disk", async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-durable-restart-comparison-"));
    const workspaceRoot = fs.realpathSync.native(
      (() => {
        const dir = path.join(tempRoot, "workspace");
        fs.mkdirSync(dir);
        initRepoWithCommit(dir);
        return dir;
      })(),
    );
    const comparisonRoot = fs.realpathSync.native(
      (() => {
        const dir = path.join(tempRoot, "comparison-root");
        fs.mkdirSync(dir);
        return dir;
      })(),
    );
    const dataDirRaw = path.join(tempRoot, "data");

    const first = openDurableComposition({ workspaceRoot, comparisonRoot, dataDirRaw });
    const sourceTaskId = randomUUID();
    first.composition.taskStore.add(buildSourceTaskRecord(sourceTaskId));
    first.composition.taskStore.setWorkingDirectory(sourceTaskId, ".");

    const comparison = first.composition.comparison;
    if (comparison === undefined) throw new Error("expected comparisons to be composed");

    const created = comparison.comparisonOrchestrator.createComparison({
      sourceTaskId,
      candidateAdapterIds: ["hall.mock-agent", "hall.codex"],
    });
    const prepared = await comparison.comparisonOrchestrator.prepareComparison(
      created.comparisonId,
    );
    expect(prepared.status).toBe("ready");

    const persistedPaths = comparison.comparisonInternalPaths?.listAll();
    expect(persistedPaths?.worktreePaths).toHaveLength(2);
    const worktreePaths = persistedPaths?.worktreePaths.map((entry) => entry.worktreePath) ?? [];
    for (const worktreePath of worktreePaths) {
      expect(fs.existsSync(worktreePath)).toBe(true);
    }

    first.db.close();

    const second = openDurableComposition({ workspaceRoot, comparisonRoot, dataDirRaw });
    const secondComparison = second.composition.comparison;
    if (secondComparison === undefined) throw new Error("expected comparisons to be composed");
    const secondInternalPaths = secondComparison.comparisonInternalPaths;
    if (secondInternalPaths === undefined)
      throw new Error("expected durable comparisonInternalPaths");

    // Before rehydration, the worktrees are still on disk but the fresh
    // `ComparisonOrchestrator` instance has no in-memory record of them —
    // proving the persisted data alone (without rehydration) is not
    // sufficient for the orchestrator to act on it.
    for (const worktreePath of worktreePaths) {
      expect(fs.existsSync(worktreePath)).toBe(true);
    }

    const recovery = await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: new Date().toISOString(),
      workspaceRoot,
      comparisonRoot,
      taskStore: second.composition.taskStore,
      taskEventStore: second.composition.eventStore,
      comparison: {
        comparisonStore: secondComparison.comparisonStore,
        comparisonEventStore: secondComparison.comparisonEventStore,
        comparisonInternalPaths: secondInternalPaths,
        gitWorktreeManager: secondComparison.gitWorktreeManager,
      },
    });
    secondComparison.comparisonOrchestrator.rehydrateInternalPaths(
      recovery.internalPathsForRehydration,
    );

    const cleaned = await secondComparison.comparisonOrchestrator.cleanupComparison(
      created.comparisonId,
    );
    expect(cleaned.cleanupStatus).toBe("completed");
    for (const worktreePath of worktreePaths) {
      expect(fs.existsSync(worktreePath)).toBe(false);
    }
  });
});
