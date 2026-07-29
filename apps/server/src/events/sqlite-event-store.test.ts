import { afterEach, describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import { SqliteEventStore } from "./sqlite-event-store.js";
import { defineEventStoreContractTests } from "./event-store-contract.js";

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

defineEventStoreContractTests(
  "SqliteEventStore (task stream)",
  (maxEventsPerStream = 2000) =>
    new SqliteEventStore({ db: openMigratedDatabase(), streamKind: "task", maxEventsPerStream }),
);

defineEventStoreContractTests(
  "SqliteEventStore (comparison_candidate stream)",
  (maxEventsPerStream = 2000) =>
    new SqliteEventStore({
      db: openMigratedDatabase(),
      streamKind: "comparison_candidate",
      maxEventsPerStream,
    }),
);

describe("SqliteEventStore — cross-stream-kind isolation and SQLite-specific behavior", () => {
  it("a task stream and a comparison_candidate stream sharing the identical raw id never see each other's events", () => {
    const db = openMigratedDatabase();
    const taskStore = new SqliteEventStore({ db, streamKind: "task", maxEventsPerStream: 100 });
    const candidateStore = new SqliteEventStore({
      db,
      streamKind: "comparison_candidate",
      maxEventsPerStream: 100,
    });
    const identity = { runId: "run-1", taskId: "shared-id", agentId: "agent-1" };

    taskStore.append(
      "shared-id",
      {
        protocolVersion: "0.1",
        eventId: "task-event",
        runId: "run-1",
        taskId: "shared-id",
        agentId: "agent-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 0,
        type: "message.delta",
        payload: { text: "task stream" },
      },
      identity,
    );

    expect(candidateStore.list("shared-id")).toHaveLength(0);
    expect(candidateStore.nextSequence("shared-id")).toBe(0);
    expect(taskStore.list("shared-id")).toHaveLength(1);
  });

  it("rejects malformed stored event JSON with CorruptRecordError", () => {
    const db = openMigratedDatabase();
    const store = new SqliteEventStore({ db, streamKind: "task", maxEventsPerStream: 100 });
    store.append(
      "stream-1",
      {
        protocolVersion: "0.1",
        eventId: "e1",
        runId: "run-1",
        taskId: "stream-1",
        agentId: "agent-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 0,
        type: "message.delta",
        payload: { text: "hi" },
      },
      { runId: "run-1", taskId: "stream-1", agentId: "agent-1" },
    );
    db.exec("UPDATE events SET payload_json = 'not valid json{{{'");
    expect(() => store.list("stream-1")).toThrow(CorruptRecordError);
  });

  it("events persist across a fresh SqliteEventStore instance reopening the same database", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    openDatabases.push(db);
    const storeA = new SqliteEventStore({ db, streamKind: "task", maxEventsPerStream: 100 });
    storeA.append(
      "stream-1",
      {
        protocolVersion: "0.1",
        eventId: "e1",
        runId: "run-1",
        taskId: "stream-1",
        agentId: "agent-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        sequence: 0,
        type: "message.delta",
        payload: { text: "hi" },
      },
      { runId: "run-1", taskId: "stream-1", agentId: "agent-1" },
    );

    const storeB = new SqliteEventStore({ db, streamKind: "task", maxEventsPerStream: 100 });
    expect(storeB.list("stream-1")).toHaveLength(1);
    expect(storeB.nextSequence("stream-1")).toBe(1);
  });
});
