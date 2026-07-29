import { afterEach, describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { CorruptRecordError } from "../persistence/persistence-errors.js";
import { SqliteComparisonStore } from "./sqlite-comparison-store.js";
import { defineComparisonStoreContractTests } from "./comparison-store-contract.js";
import type { AgentComparisonRecord } from "./comparison-record.js";

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

defineComparisonStoreContractTests(
  "SqliteComparisonStore",
  () => new SqliteComparisonStore({ db: openMigratedDatabase(), maxComparisons: 100 }),
);

function minimalRecord(comparisonId: string): AgentComparisonRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    comparisonId,
    sourceTaskId: "task-1",
    title: "Compare agents",
    description: "",
    priority: "normal",
    requirements: undefined,
    baseCommit: undefined,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    preparedAt: undefined,
    candidates: [
      {
        candidateId: `${comparisonId}-a`,
        adapterId: "hall.claude-code",
        displayName: "Claude Code",
        status: "pending",
        executionTrust: undefined,
        runId: undefined,
        agentId: undefined,
        createdAt: now,
        preparedAt: undefined,
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
        candidateId: `${comparisonId}-b`,
        adapterId: "hall.codex",
        displayName: "Codex",
        status: "pending",
        executionTrust: undefined,
        runId: undefined,
        agentId: undefined,
        createdAt: now,
        preparedAt: undefined,
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
  };
}

describe("SqliteComparisonStore — SQLite-specific behavior", () => {
  it("rejects malformed stored JSON with CorruptRecordError", () => {
    const db = openMigratedDatabase();
    const store = new SqliteComparisonStore({ db, maxComparisons: 100 });
    store.add(minimalRecord("cmp-1"));
    db.exec(
      `UPDATE comparisons SET requirements_json = 'not valid json{{{' WHERE comparison_id = 'cmp-1'`,
    );
    expect(() => store.get("cmp-1")).toThrow(CorruptRecordError);
  });

  it("comparisons persist across a fresh SqliteComparisonStore instance reopening the same database", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    openDatabases.push(db);
    const storeA = new SqliteComparisonStore({ db, maxComparisons: 100 });
    storeA.add(minimalRecord("cmp-1"));
    storeA.claimPreparing("cmp-1");
    const revisionBefore = storeA.getRevision("cmp-1");

    const storeB = new SqliteComparisonStore({ db, maxComparisons: 100 });
    expect(storeB.getRevision("cmp-1")).toBe(revisionBefore);
    expect(storeB.get("cmp-1").status).toBe("preparing");
  });
});
