import { describe, expect, it } from "vitest";
import { HallDatabase } from "./database.js";
import { runMigrations } from "./migration-runner.js";
import { HIGHEST_KNOWN_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { SqliteAgentWorktreeStore } from "../agent-worktrees/sqlite-agent-worktree-store.js";

function migratedDb(): HallDatabase {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  return db;
}

describe("migration 9 — agent worktree immutable adapter/agent identity", () => {
  it("adds nullable adapter_id and agent_id columns", () => {
    const db = migratedDb();
    const columns = db.prepare("PRAGMA table_info(agent_worktrees)").all() as {
      name: string;
      notnull: number;
    }[];
    const adapterIdColumn = columns.find((column) => column.name === "adapter_id");
    const agentIdColumn = columns.find((column) => column.name === "agent_id");
    expect(adapterIdColumn?.notnull).toBe(0);
    expect(agentIdColumn?.notnull).toBe(0);
    db.close();
  });

  it("a freshly created worktree round-trips its immutable adapter/agent identity", () => {
    const db = migratedDb();
    const store = new SqliteAgentWorktreeStore({ db });
    const record = store.createCreating({
      worktreeId: "wt-identity",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      adapterId: "hall.codex",
      agentId: "agent-1",
      canonicalSourceRepositoryRoot: "C:\\safe\\repo",
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: "0".repeat(40),
      canonicalWorktreePath: "C:\\safe\\root\\wt_wt-identity",
      createdAt: "2026-08-05T00:00:00.000Z",
    });
    expect(record.adapterId).toBe("hall.codex");
    expect(record.agentId).toBe("agent-1");
    expect(store.get("wt-identity").adapterId).toBe("hall.codex");
    expect(store.get("wt-identity").agentId).toBe("agent-1");
    db.close();
  });

  it("a legacy row created before this migration reads back with undefined identity, never a fabricated value", () => {
    const db = HallDatabase.openInMemory();
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)");
    for (const migration of MIGRATIONS.filter((candidate) => candidate.version < 9)) {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        "2026-08-03T00:00:00.000Z",
      );
    }
    db.exec(`
      INSERT INTO agent_worktrees (
        worktree_id, hall_task_id, hall_agent_run_id, source_repository_root,
        source_working_directory_relative_path, base_commit, worktree_path,
        status, created_at, revision
      ) VALUES (
        'wt-legacy', 'task-legacy', 'run-legacy', 'C:\\safe\\repo',
        '.', '${"0".repeat(40)}', 'C:\\safe\\root\\wt_wt-legacy',
        'ready', '2026-08-01T00:00:00.000Z', 0
      )
    `);
    runMigrations(db);
    const version = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    expect(version.version).toBe(HIGHEST_KNOWN_SCHEMA_VERSION);

    const store = new SqliteAgentWorktreeStore({ db });
    const legacy = store.get("wt-legacy");
    expect(legacy.adapterId).toBeUndefined();
    expect(legacy.agentId).toBeUndefined();
    expect(legacy.status).toBe("ready");
    db.close();
  });

  it("runs after migration 8 in the ordered migration list", () => {
    expect(MIGRATIONS.at(-1)?.version).toBe(9);
  });
});
