import { afterEach } from "vitest";
import { HallDatabase } from "../persistence/database.js";
import { runMigrations } from "../persistence/migration-runner.js";
import { withTransaction } from "../persistence/transaction.js";
import { SqliteCeoPlanRunStore } from "./sqlite-ceo-plan-run-store.js";
import { SqliteExecutionSignalStore } from "./sqlite-execution-signal-store.js";
import {
  buildExecutionAtomicityHarnessDeps,
  runCeoPlanExecutionAtomicityContractTests,
} from "./ceo-plan-execution-atomicity.contract.js";

/**
 * Durable-mode call site for the shared execution-atomicity contract,
 * mirroring `ceo-plan-delegation-atomicity.durable.test.ts`'s pattern —
 * a real (in-memory, for test speed) `HallDatabase` and the real SQLite
 * stores, proving `withTransaction`'s `BEGIN IMMEDIATE`/rollback gives
 * the exact same all-or-nothing behavior for every scenario the ephemeral
 * call site proves for `createEphemeralAtomicUnit`.
 */
const openDbs: HallDatabase[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

runCeoPlanExecutionAtomicityContractTests("durable", (adapter) => {
  const db = HallDatabase.openInMemory();
  runMigrations(db);
  openDbs.push(db);
  const planRunStore = new SqliteCeoPlanRunStore({ db });
  const signalStore = new SqliteExecutionSignalStore({ db });
  const runAtomicUnit = <T>(fn: () => T): T => withTransaction(db, fn);
  return buildExecutionAtomicityHarnessDeps(planRunStore, signalStore, runAtomicUnit, adapter);
});
