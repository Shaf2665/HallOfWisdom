import { afterEach, describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import { SqliteTaskStore } from "../tasks/sqlite-task-store.js";
import type { TaskStorePort } from "../tasks/task-store-port.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";
import { defineBoardStoreContractTests } from "./board-store-contract.js";

const openDatabases: HallDatabase[] = [];
function openMigratedDatabase(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

function addTask(taskStore: TaskStorePort, taskId: string): void {
  taskStore.add({
    task: {
      taskId,
      projectId: "project-1",
      title: "Board contract task",
      description: "",
      priority: "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    runId: undefined,
    adapterId: undefined,
    agentId: undefined,
    eventCount: 0,
    lastSequence: undefined,
    terminalEventType: undefined,
    failure: undefined,
    cancellationRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: undefined,
    completedAt: undefined,
    assignedExecutionTrust: undefined,
  });
}

defineBoardStoreContractTests(
  "SqliteBoardStore",
  (taskStore, maxBoards = 100) => {
    const db = openMigratedDatabase();
    return new SqliteBoardStore({ db, maxBoards, taskStore });
  },
  () => new SqliteTaskStore({ db: openMigratedDatabase(), maxTasks: 100 }),
  addTask,
);

describe("SqliteBoardStore — SQLite-specific behavior", () => {
  it("rejects malformed stored board data with CorruptRecordError", () => {
    const db = openMigratedDatabase();
    const taskStore = new SqliteTaskStore({ db, maxTasks: 100 });
    const store = new SqliteBoardStore({ db, maxBoards: 100, taskStore });
    // A `CHECK` constraint on `kind` already prevents a wholly-unknown kind
    // from ever being written — this simulates a subtler, schema-level-valid
    // but domain-invalid corruption instead: a "task" board with no task_id,
    // which `communicationBoardSchema`'s discriminated union rejects.
    db.exec(
      `INSERT INTO boards (board_id, kind, title, task_id, created_at, updated_at, message_count)
       VALUES ('task:orphan', 'task', 'Orphaned', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0)`,
    );
    expect(() => store.get("task:orphan")).toThrow(CorruptRecordError);
  });

  it("boards persist across a fresh SqliteBoardStore instance reopening the same database", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    openDatabases.push(db);
    const taskStore = new SqliteTaskStore({ db, maxTasks: 100 });
    const storeA = new SqliteBoardStore({ db, maxBoards: 100, taskStore });
    storeA.seedGeneralBoard("2026-01-01T00:00:00.000Z");

    const storeB = new SqliteBoardStore({ db, maxBoards: 100, taskStore });
    expect(storeB.get("hall.general").boardId).toBe("hall.general");
  });
});
