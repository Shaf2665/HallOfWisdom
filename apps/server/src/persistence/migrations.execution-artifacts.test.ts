import { describe, expect, it } from "vitest";
import { HallDatabase } from "./database.js";
import { runMigrations } from "./migration-runner.js";
import { MIGRATIONS } from "./migrations.js";

function migratedDb(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  return db;
}

function insertArtifactSql(
  overrides: Partial<Record<string, string | number | null>> = {},
): string {
  const values: Record<string, string | number | null> = {
    artifact_id: "artifact-1",
    hall_task_id: "task-1",
    hall_agent_run_id: "run-1",
    adapter_id: "codex",
    worktree_id: null,
    provider_execution_ref: null,
    terminal_outcome: "completed",
    terminal_reason_code: null,
    safe_terminal_summary: null,
    started_at: "2026-08-03T10:00:00.000Z",
    finished_at: "2026-08-03T10:01:00.000Z",
    duration_ms: 60_000,
    exit_code: 0,
    base_commit: "a".repeat(40),
    final_commit: "b".repeat(40),
    changed_files_json: JSON.stringify(["src/a.ts"]),
    changed_files_truncated: 0,
    diff_files_changed: 1,
    diff_insertions: 2,
    diff_deletions: 3,
    final_summary: "Done.",
    final_summary_truncated: 0,
    created_at: "2026-08-03T10:01:01.000Z",
    ...overrides,
  };
  const columns = Object.keys(values);
  const rendered = columns.map((column) => renderSqlValue(values[column]));
  return `INSERT INTO agent_execution_artifacts (${columns.join(", ")}) VALUES (${rendered.join(", ")})`;
}

function renderSqlValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/gu, "''")}'`;
}

describe("migration 8 — agent execution artifacts", () => {
  it("creates the table, primary key, and expected indexes", () => {
    const db = migratedDb();
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("agent_execution_artifacts");
    expect(table).toBeTruthy();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name")
      .all("agent_execution_artifacts") as { name: string }[];
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "idx_agent_execution_artifacts_created",
        "idx_agent_execution_artifacts_task",
        "idx_agent_execution_artifacts_worktree",
      ]),
    );
    const columns = db.prepare("PRAGMA table_info(agent_execution_artifacts)").all() as {
      name: string;
      pk: number;
    }[];
    expect(columns.find((column) => column.name === "artifact_id")?.pk).toBe(1);
    expect(columns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["stdout", "stderr", "worktree_path", "source_repository_root"]),
    );
    db.close();
  });

  it("enforces unique Hall agent-run artifacts", () => {
    const db = migratedDb();
    db.exec(insertArtifactSql());
    expect(() => {
      db.exec(insertArtifactSql({ artifact_id: "artifact-2", hall_agent_run_id: "run-1" }));
    }).toThrow();
    db.close();
  });

  it("enforces outcome, boolean, and nonnegative checks", () => {
    const db = migratedDb();
    expect(() => {
      db.exec(insertArtifactSql({ terminal_outcome: "teleported" }));
    }).toThrow();
    expect(() => {
      db.exec(insertArtifactSql({ changed_files_truncated: 2 }));
    }).toThrow();
    expect(() => {
      db.exec(insertArtifactSql({ final_summary_truncated: 2 }));
    }).toThrow();
    expect(() => {
      db.exec(insertArtifactSql({ duration_ms: -1 }));
    }).toThrow();
    expect(() => {
      db.exec(insertArtifactSql({ diff_files_changed: -1 }));
    }).toThrow();
    expect(() => {
      db.exec(insertArtifactSql({ diff_insertions: -1 }));
    }).toThrow();
    expect(() => {
      db.exec(insertArtifactSql({ diff_deletions: -1 }));
    }).toThrow();
    db.close();
  });

  it("runs after migration 7 in the ordered migration list", () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("migrates a pre-migration-8 database forward without dropping existing tables", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)");
    for (const migration of MIGRATIONS.filter((candidate) => candidate.version < 8)) {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        "2026-08-03T00:00:00.000Z",
      );
    }
    runMigrations(db);
    const version = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    expect(version.version).toBe(8);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("agent_worktrees"),
    ).toBeTruthy();
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("agent_execution_artifacts"),
    ).toBeTruthy();
    db.close();
  });
});
