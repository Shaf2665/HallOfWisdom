import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { AgentWorktreeCorruptRecordError } from "./agent-worktree-errors.js";
import { runAgentWorktreeStoreContractTests } from "./agent-worktree-store.contract.js";
import { SqliteAgentWorktreeStore } from "./sqlite-agent-worktree-store.js";

const openDbs: HallDatabase[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function buildStore(): SqliteAgentWorktreeStore {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  openDbs.push(db);
  return new SqliteAgentWorktreeStore({ db });
}

runAgentWorktreeStoreContractTests("durable", buildStore);

describe("SqliteAgentWorktreeStore durability and corrupt-row behavior", () => {
  it("survives database close and reopen", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hall-agent-worktrees-db-"));
    tempDirs.push(dataDir);
    const firstDb = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    runMigrations(firstDb);
    new SqliteAgentWorktreeStore({ db: firstDb }).createCreating({
      worktreeId: "wt-1",
      hallTaskId: "task-1",
      hallAgentRunId: "run-1",
      canonicalSourceRepositoryRoot: "C:\\safe\\repo",
      sourceWorkingDirectoryRelativePath: ".",
      baseCommit: "0".repeat(40),
      canonicalWorktreePath: "C:\\safe\\root\\wt_wt-1",
      createdAt: "2026-08-02T10:00:00.000Z",
    });
    firstDb.close();

    const secondDb = HallDatabase.open({ dataDir, busyTimeoutMs: 2000 });
    openDbs.push(secondDb);
    const reopened = new SqliteAgentWorktreeStore({ db: secondDb });
    expect(reopened.get("wt-1").hallAgentRunId).toBe("run-1");
  });

  it("fails safely when a stored lifecycle value is corrupt", () => {
    const db = HallDatabase.openInMemory();
    runMigrations(db);
    openDbs.push(db);
    db.exec("PRAGMA ignore_check_constraints = ON;");
    db.prepare(
      `INSERT INTO agent_worktrees (
        worktree_id, hall_task_id, hall_agent_run_id, source_repository_root,
        source_working_directory_relative_path, base_commit, worktree_path, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "wt-corrupt",
      "task-1",
      "run-1",
      "C:\\safe\\repo",
      ".",
      "0".repeat(40),
      "C:\\safe\\root\\wt_corrupt",
      "teleported",
      "2026-08-02T10:00:00.000Z",
    );
    const store = new SqliteAgentWorktreeStore({ db });
    expect(() => store.get("wt-corrupt")).toThrow(AgentWorktreeCorruptRecordError);
  });
});
