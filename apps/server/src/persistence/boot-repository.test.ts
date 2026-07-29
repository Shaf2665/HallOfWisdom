import { afterEach, describe, expect, it } from "vitest";
import { HallDatabase } from "./database.js";
import { runMigrations } from "./migration-runner.js";
import {
  getPreviousBoot,
  recordBootStarted,
  recordCleanShutdown,
  recordRecoverySummary,
} from "./boot-repository.js";

const openDatabases: HallDatabase[] = [];
afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

function openMigratedDatabase(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  openDatabases.push(db);
  return db;
}

describe("boot-repository", () => {
  it("reports no previous boot on the very first startup ever recorded", () => {
    const db = openMigratedDatabase();
    recordBootStarted(db, "boot-1", "2026-01-01T00:00:00.000Z");
    expect(getPreviousBoot(db, "boot-1")).toBeUndefined();
  });

  it("reports the immediately preceding boot as unclean when it never recorded a clean shutdown", () => {
    const db = openMigratedDatabase();
    recordBootStarted(db, "boot-1", "2026-01-01T00:00:00.000Z");
    recordBootStarted(db, "boot-2", "2026-01-01T01:00:00.000Z");

    const previous = getPreviousBoot(db, "boot-2");
    expect(previous?.bootId).toBe("boot-1");
    expect(previous?.cleanShutdownAt).toBeUndefined();
  });

  it("reports the immediately preceding boot as clean once it recorded a clean shutdown", () => {
    const db = openMigratedDatabase();
    recordBootStarted(db, "boot-1", "2026-01-01T00:00:00.000Z");
    recordCleanShutdown(db, "boot-1", "2026-01-01T00:05:00.000Z");
    recordBootStarted(db, "boot-2", "2026-01-01T01:00:00.000Z");

    const previous = getPreviousBoot(db, "boot-2");
    expect(previous?.cleanShutdownAt).toBe("2026-01-01T00:05:00.000Z");
  });

  it("orders by insertion (rowid), not by started_at, so same-instant boots still resolve correctly", () => {
    const db = openMigratedDatabase();
    const SAME_INSTANT = "2026-01-01T00:00:00.000Z";
    recordBootStarted(db, "boot-1", SAME_INSTANT);
    recordBootStarted(db, "boot-2", SAME_INSTANT);
    recordBootStarted(db, "boot-3", SAME_INSTANT);

    expect(getPreviousBoot(db, "boot-3")?.bootId).toBe("boot-2");
  });

  it("persists a recovery summary on the correct boot row", () => {
    const db = openMigratedDatabase();
    recordBootStarted(db, "boot-1", "2026-01-01T00:00:00.000Z");
    recordRecoverySummary(db, "boot-1", JSON.stringify({ tasksScanned: 3 }));
    recordBootStarted(db, "boot-2", "2026-01-01T01:00:00.000Z");

    const previous = getPreviousBoot(db, "boot-2");
    expect(previous?.recoverySummaryJson).toBe(JSON.stringify({ tasksScanned: 3 }));
  });
});
