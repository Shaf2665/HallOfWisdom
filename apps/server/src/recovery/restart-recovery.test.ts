import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseHallTask, type NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { ConfigurationFingerprintMismatchError } from "../persistence/persistence-errors.js";
import { recordCleanShutdown } from "../persistence/boot-repository.js";
import { SqliteTaskStore } from "../tasks/sqlite-task-store.js";
import { SqliteEventStore } from "../events/sqlite-event-store.js";
import { SqliteComparisonStore } from "../comparisons/sqlite-comparison-store.js";
import { SqliteComparisonInternalPaths } from "../comparisons/sqlite-comparison-internal-paths.js";
import { GitWorktreeManager } from "../comparisons/git-worktree-manager.js";
import { nodeProcessSpawner } from "../comparisons/process-spawner.js";
import type { TaskRecord } from "../tasks/task-record.js";
import { runRestartRecovery } from "./restart-recovery.js";

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * The one true close-then-reopen wiring test for the whole durable-mode
 * persistence layer: every other test in this phase exercises a single
 * `HallDatabase` instance that never closes. This one opens a real on-disk
 * database, populates it through the same store classes production
 * composition will use, closes the connection (simulating process exit),
 * opens a brand-new `HallDatabase` instance against the SAME file (simulating
 * the next process's startup), and asserts state actually survived — the
 * scenario `openInMemory()`-based tests structurally cannot cover.
 */
function openHarness(dataDir: string): {
  readonly db: HallDatabase;
  readonly taskStore: SqliteTaskStore;
  readonly taskEventStore: SqliteEventStore;
  readonly comparisonStore: SqliteComparisonStore;
  readonly comparisonEventStore: SqliteEventStore;
  readonly comparisonInternalPaths: SqliteComparisonInternalPaths;
} {
  const db = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
  runMigrations(db);
  return {
    db,
    taskStore: new SqliteTaskStore({ db, maxTasks: 100 }),
    taskEventStore: new SqliteEventStore({ db, streamKind: "task", maxEventsPerStream: 50 }),
    comparisonStore: new SqliteComparisonStore({ db, maxComparisons: 100 }),
    comparisonEventStore: new SqliteEventStore({
      db,
      streamKind: "comparison_candidate",
      maxEventsPerStream: 50,
    }),
    comparisonInternalPaths: new SqliteComparisonInternalPaths({ db }),
  };
}

function buildTaskRecord(taskId: string, status: string, runId: string | undefined): TaskRecord {
  const task = parseHallTask({
    taskId,
    projectId: "proj-1",
    title: "Task",
    description: "",
    priority: "normal",
    status,
    dependencyTaskIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  return {
    task,
    runId,
    adapterId: "hall.claude-code",
    agentId: "agent-1",
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: NOW,
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: undefined,
  };
}

function makeStartedEvent(taskId: string): NormalizedAgentEvent {
  return {
    protocolVersion: "0.1",
    eventId: `${taskId}-event-0`,
    runId: "run-1",
    taskId,
    agentId: "agent-1",
    timestamp: NOW,
    sequence: 0,
    type: "run.started",
    payload: {},
  };
}

describe("runRestartRecovery (real on-disk database, close + reopen)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hall-restart-recovery-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("reconciles an interrupted task run against real on-disk state, survives a close/reopen, and reports the next boot as unclean", async () => {
    const first = openHarness(dataDir);
    first.taskStore.add(buildTaskRecord("t-1", "running", "run-1"));
    first.taskEventStore.append("t-1", makeStartedEvent("t-1"), {
      runId: "run-1",
      taskId: "t-1",
      agentId: "agent-1",
    });

    const firstRecovery = await runRestartRecovery({
      db: first.db,
      bootId: "boot-1",
      startedAt: NOW,
      workspaceRoot: "/workspace",
      comparisonRoot: undefined,
      taskStore: first.taskStore,
      taskEventStore: first.taskEventStore,
      comparison: undefined,
    });

    expect(firstRecovery.summary.previousShutdown).toBe("first_start");
    expect(firstRecovery.summary.interruptedTaskRunCount).toBe(1);
    expect(first.taskStore.get("t-1").task.status).toBe("failed");

    // Simulate process exit without a graceful shutdown (no recordCleanShutdown call).
    first.db.close();

    // A brand-new process, opening the same file.
    const second = openHarness(dataDir);
    expect(second.taskStore.get("t-1").task.status).toBe("failed");

    const secondRecovery = await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: "2026-01-01T01:00:00.000Z",
      workspaceRoot: "/workspace",
      comparisonRoot: undefined,
      taskStore: second.taskStore,
      taskEventStore: second.taskEventStore,
      comparison: undefined,
    });

    // Keyed off boot-1 never recording a clean shutdown — the previous
    // process's exit was unclean.
    expect(secondRecovery.summary.previousShutdown).toBe("unclean");
    // Already terminal from the first pass — idempotent, nothing more to do.
    expect(secondRecovery.summary.interruptedTaskRunCount).toBe(0);
    expect(secondRecovery.summary.taskEventProjectionsRepaired).toBe(0);

    second.db.close();
  });

  it("reports the next boot as clean once the previous boot recorded a clean shutdown", async () => {
    const first = openHarness(dataDir);
    await runRestartRecovery({
      db: first.db,
      bootId: "boot-1",
      startedAt: NOW,
      workspaceRoot: "/workspace",
      comparisonRoot: undefined,
      taskStore: first.taskStore,
      taskEventStore: first.taskEventStore,
      comparison: undefined,
    });
    recordCleanShutdown(first.db, "boot-1", "2026-01-01T00:10:00.000Z");
    first.db.close();

    const second = openHarness(dataDir);
    const secondRecovery = await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: "2026-01-01T01:00:00.000Z",
      workspaceRoot: "/workspace",
      comparisonRoot: undefined,
      taskStore: second.taskStore,
      taskEventStore: second.taskEventStore,
      comparison: undefined,
    });

    expect(secondRecovery.summary.previousShutdown).toBe("clean");
    second.db.close();
  });

  it("fails closed on reopen against a different workspaceRoot than the database was created for", async () => {
    const first = openHarness(dataDir);
    await runRestartRecovery({
      db: first.db,
      bootId: "boot-1",
      startedAt: NOW,
      workspaceRoot: "/workspace-a",
      comparisonRoot: undefined,
      taskStore: first.taskStore,
      taskEventStore: first.taskEventStore,
      comparison: undefined,
    });
    first.db.close();

    const second = openHarness(dataDir);
    await expect(
      runRestartRecovery({
        db: second.db,
        bootId: "boot-2",
        startedAt: "2026-01-01T01:00:00.000Z",
        workspaceRoot: "/workspace-b",
        comparisonRoot: undefined,
        taskStore: second.taskStore,
        taskEventStore: second.taskEventStore,
        comparison: undefined,
      }),
    ).rejects.toThrow(ConfigurationFingerprintMismatchError);
    second.db.close();
  });

  it("returns persisted comparison internal paths for orchestrator rehydration, surviving a close/reopen", async () => {
    const first = openHarness(dataDir);
    first.comparisonStore.add({
      comparisonId: "cmp-1",
      sourceTaskId: "t-1",
      title: "Compare",
      description: "",
      priority: "normal",
      requirements: undefined,
      baseCommit: "a".repeat(40),
      status: "ready",
      createdAt: NOW,
      updatedAt: NOW,
      preparedAt: NOW,
      candidates: [
        {
          candidateId: "cmp-1-a",
          adapterId: "hall.claude-code",
          displayName: "Claude Code",
          status: "prepared",
          executionTrust: "isolated",
          runId: undefined,
          agentId: undefined,
          createdAt: NOW,
          preparedAt: NOW,
          startedAt: undefined,
          completedAt: undefined,
          eventCount: 0,
          lastSequence: undefined,
          terminalEventType: undefined,
          failure: undefined,
          cancellationRequested: false,
          resultEvidence: undefined,
          safeFailureReason: undefined,
        },
        {
          candidateId: "cmp-1-b",
          adapterId: "hall.codex",
          displayName: "Codex",
          status: "prepared",
          executionTrust: "trusted_local",
          runId: undefined,
          agentId: undefined,
          createdAt: NOW,
          preparedAt: NOW,
          startedAt: undefined,
          completedAt: undefined,
          eventCount: 0,
          lastSequence: undefined,
          terminalEventType: undefined,
          failure: undefined,
          cancellationRequested: false,
          resultEvidence: undefined,
          safeFailureReason: undefined,
        },
      ],
      cleanupStatus: "not_started",
      cleanupError: undefined,
      prepareFailureCode: undefined,
      prepareFailureReason: undefined,
      preference: undefined,
    });
    first.comparisonInternalPaths.setSourceRepositoryPath("cmp-1", "/repos/source");
    first.comparisonInternalPaths.setWorktreePath("cmp-1-a", "cmp-1", "/comparison-root/cmp-1-a");
    first.comparisonInternalPaths.setWorktreePath("cmp-1-b", "cmp-1", "/comparison-root/cmp-1-b");
    first.db.close();

    const second = openHarness(dataDir);
    const recovery = await runRestartRecovery({
      db: second.db,
      bootId: "boot-2",
      startedAt: NOW,
      workspaceRoot: "/workspace",
      comparisonRoot: undefined,
      taskStore: second.taskStore,
      taskEventStore: second.taskEventStore,
      comparison: {
        comparisonStore: second.comparisonStore,
        comparisonEventStore: second.comparisonEventStore,
        comparisonInternalPaths: second.comparisonInternalPaths,
        gitWorktreeManager: new GitWorktreeManager({
          spawner: nodeProcessSpawner,
          gitExecutablePath: "git",
          timeoutMs: 15000,
          comparisonRoot: path.join(dataDir, "comparison-root-not-created"),
        }),
      },
    });

    expect(recovery.internalPathsForRehydration.sourceRepositoryPaths).toEqual([
      { comparisonId: "cmp-1", sourceRepositoryPath: "/repos/source" },
    ]);
    expect(recovery.internalPathsForRehydration.worktreePaths).toEqual(
      expect.arrayContaining([
        { candidateId: "cmp-1-a", worktreePath: "/comparison-root/cmp-1-a" },
        { candidateId: "cmp-1-b", worktreePath: "/comparison-root/cmp-1-b" },
      ]),
    );
    second.db.close();
  });
});
