import { afterEach } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { SqliteExecutionSignalStore } from "./sqlite-execution-signal-store.js";
import { runExecutionSignalStoreContractTests } from "./execution-signal-store.contract.js";

/**
 * `ceo_plan_execution_signals.run_id` is a foreign key into `ceo_plan_runs`
 * (migration 5, `foreign_keys = ON` — `database.ts`) — real deployments
 * never have a signal without a real run row behind it. This harness
 * seeds the two run ids the shared contract exercises ("run-1", "run-2")
 * before returning the store, so the contract tests can focus purely on
 * signal-queue behavior.
 */
const openDbs: HallDatabase[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function seedRun(db: HallDatabase, runId: string): void {
  db.exec(
    `INSERT INTO ceo_plan_runs (run_id, plan_id, plan_version, status, execution_mode, policy_snapshot_json, created_at)
     VALUES ('${runId}', '${runId}-plan', 1, 'running', 'autonomous', '{}', '2026-07-31T00:00:00.000Z')`,
  );
}

runExecutionSignalStoreContractTests("durable", () => {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  seedRun(db, "run-1");
  seedRun(db, "run-2");
  openDbs.push(db);
  return new SqliteExecutionSignalStore({ db });
});
