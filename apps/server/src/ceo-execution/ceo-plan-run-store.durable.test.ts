import { afterEach } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { SqliteCeoPlanRunStore } from "./sqlite-ceo-plan-run-store.js";
import { runCeoPlanRunStoreContractTests } from "./ceo-plan-run-store.contract.js";

/**
 * Durable-mode call site — a real, migrated, in-memory `HallDatabase` (the
 * same SQLite engine and constraints a file-backed deployment uses), not a
 * temp-file dance: this contract proves store *behavior*, not file
 * persistence across a real restart (that is `ceo-plan-execution-durable-restart.test.ts`'s job).
 */
const openDbs: HallDatabase[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

runCeoPlanRunStoreContractTests("durable", () => {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  openDbs.push(db);
  return new SqliteCeoPlanRunStore({ db });
});
