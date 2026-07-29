import { afterEach, describe, expect, it } from "vitest";
import { HallDatabase } from "./database.js";
import { runMigrations } from "./migration-runner.js";
import { ConfigurationFingerprintMismatchError } from "./persistence-errors.js";
import { checkOrRecordConfigurationFingerprint } from "./server-metadata-repository.js";

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

describe("checkOrRecordConfigurationFingerprint", () => {
  it("records the fingerprint on first use rather than comparing", () => {
    const db = openMigratedDatabase();
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: "/cmp",
      });
    }).not.toThrow();
  });

  it("passes when the same roots are supplied again", () => {
    const db = openMigratedDatabase();
    checkOrRecordConfigurationFingerprint(db, { workspaceRoot: "/ws", comparisonRoot: "/cmp" });
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, { workspaceRoot: "/ws", comparisonRoot: "/cmp" });
    }).not.toThrow();
  });

  it("fails closed when workspaceRoot differs from what was previously recorded", () => {
    const db = openMigratedDatabase();
    checkOrRecordConfigurationFingerprint(db, { workspaceRoot: "/ws", comparisonRoot: undefined });
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/different-ws",
        comparisonRoot: undefined,
      });
    }).toThrow(ConfigurationFingerprintMismatchError);
  });

  it("fails closed when comparisonRoot differs from what was previously recorded", () => {
    const db = openMigratedDatabase();
    checkOrRecordConfigurationFingerprint(db, { workspaceRoot: "/ws", comparisonRoot: "/cmp" });
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: "/different-cmp",
      });
    }).toThrow(ConfigurationFingerprintMismatchError);
  });

  it("allows a startup that omits comparisonRoot entirely even though one was previously recorded", () => {
    const db = openMigratedDatabase();
    checkOrRecordConfigurationFingerprint(db, { workspaceRoot: "/ws", comparisonRoot: "/cmp" });
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: undefined,
      });
    }).not.toThrow();
  });

  it("records a comparisonRoot supplied for the first time on a database that only ever had workspaceRoot recorded", () => {
    const db = openMigratedDatabase();
    checkOrRecordConfigurationFingerprint(db, { workspaceRoot: "/ws", comparisonRoot: undefined });
    checkOrRecordConfigurationFingerprint(db, { workspaceRoot: "/ws", comparisonRoot: "/cmp" });
    expect(() => {
      checkOrRecordConfigurationFingerprint(db, {
        workspaceRoot: "/ws",
        comparisonRoot: "/different-cmp",
      });
    }).toThrow(ConfigurationFingerprintMismatchError);
  });
});
