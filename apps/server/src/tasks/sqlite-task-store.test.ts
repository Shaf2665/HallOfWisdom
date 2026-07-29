import { afterEach, describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import { SqliteTaskStore } from "./sqlite-task-store.js";
import { defineTaskStoreContractTests } from "./task-store-contract.js";
import type { HallTask } from "@hall-of-wisdom/protocol";
import type { TaskRecord } from "./task-record.js";

function makeTask(taskId: string, overrides: Partial<HallTask> = {}): HallTask {
  return {
    taskId,
    projectId: "project-1",
    title: "Contract test task",
    description: "",
    priority: "normal",
    status: "ready",
    dependencyTaskIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRecord(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task: makeTask(taskId),
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
    ...overrides,
  };
}

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

defineTaskStoreContractTests("SqliteTaskStore", () => {
  const db = openMigratedDatabase();
  return new SqliteTaskStore({ db, maxTasks: 100 });
});

describe("SqliteTaskStore — SQLite-specific behavior", () => {
  it("rejects malformed stored JSON with CorruptRecordError rather than crashing or silently dropping the row", () => {
    const db = openMigratedDatabase();
    const store = new SqliteTaskStore({ db, maxTasks: 100 });
    store.add(makeRecord("task-1"));
    db.exec(`UPDATE tasks SET requirements_json = 'not valid json{{{' WHERE task_id = 'task-1'`);
    expect(() => store.get("task-1")).toThrow(CorruptRecordError);
  });

  it("rejects an impossible stored status against the domain schema with CorruptRecordError", () => {
    const db = openMigratedDatabase();
    const store = new SqliteTaskStore({ db, maxTasks: 100 });
    store.add(makeRecord("task-1"));
    db.exec(`UPDATE tasks SET status = 'not-a-real-status' WHERE task_id = 'task-1'`);
    expect(() => store.get("task-1")).toThrow(CorruptRecordError);
  });

  it("SQL-injection-like text in a title is stored and returned as ordinary data, never executed", () => {
    const db = openMigratedDatabase();
    const store = new SqliteTaskStore({ db, maxTasks: 100 });
    const dangerous = "'; DROP TABLE tasks; --";
    store.add(makeRecord("task-1", { task: makeTask("task-1", { title: dangerous }) }));
    expect(store.get("task-1").task.title).toBe(dangerous);
    // The table must still exist and be queryable.
    expect(store.list()).toHaveLength(1);
  });

  it("revision persists across a fresh SqliteTaskStore instance reopening the same underlying database", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    openDatabases.push(db);
    const storeA = new SqliteTaskStore({ db, maxTasks: 100 });
    storeA.add(makeRecord("task-1"));
    storeA.updateStatus("task-1", "backlog");
    const revisionBefore = storeA.getRevision("task-1");

    const storeB = new SqliteTaskStore({ db, maxTasks: 100 });
    expect(storeB.getRevision("task-1")).toBe(revisionBefore);
    expect(storeB.get("task-1").task.status).toBe("backlog");
  });
});
