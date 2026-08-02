import { describe, expect, it } from "vitest";
import { HallDatabase } from "./database.js";
import { runMigrations } from "./migration-runner.js";
import { HIGHEST_KNOWN_SCHEMA_VERSION } from "./migrations.js";
import { MigrationFailedError, UnsupportedSchemaVersionError } from "./persistence-errors.js";

function tableNames(db: HallDatabase): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("runMigrations", () => {
  it("an empty database receives migration 1 and reaches the highest known version", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    const version = (
      db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }
    ).v;
    expect(version).toBe(HIGHEST_KNOWN_SCHEMA_VERSION);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        "tasks",
        "task_working_directories",
        "events",
        "boards",
        "messages",
        "comparisons",
        "comparison_candidates",
        "comparison_internal_paths",
        "comparison_candidate_worktrees",
        "agent_worktrees",
        "server_metadata",
        "boots",
      ]),
    );
    db.close();
  });

  it("reopening an already-migrated database does not rerun migration 1 (idempotent, no error on duplicate CREATE TABLE)", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    expect(() => {
      runMigrations(db);
    }).not.toThrow();
    const rows = db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as {
      c: number;
    };
    expect(rows.c).toBe(HIGHEST_KNOWN_SCHEMA_VERSION);
    db.close();
  });

  it("MigrationFailedError is thrown (not a raw SQLite error) when a migration's up() itself fails, and no partial schema or version row survives", () => {
    const db = HallDatabase.openInMemory();
    // Force a genuine migration failure: corrupt schema_migrations so the
    // recorded version looks like 0 but the tasks table already exists,
    // making migration 1's CREATE TABLE fail with "table already exists"
    // partway through its larger multi-statement `up()`.
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)");
    db.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY)");
    expect(() => {
      runMigrations(db);
    }).toThrow(MigrationFailedError);
    // Schema version was never recorded — the failed migration is not marked applied.
    const row = db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number };
    expect(row.c).toBe(0);
    // None of migration 1's other tables (which come after `tasks` in its
    // script) were left behind by the failed, rolled-back transaction.
    expect(tableNames(db)).not.toContain("boards");
    expect(tableNames(db)).not.toContain("comparisons");
    db.close();
  });

  it("a database recorded at a newer-than-known schema version fails closed with UnsupportedSchemaVersionError", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      HIGHEST_KNOWN_SCHEMA_VERSION + 1,
      new Date().toISOString(),
    );
    expect(() => {
      runMigrations(db);
    }).toThrow(UnsupportedSchemaVersionError);
    db.close();
  });
});
