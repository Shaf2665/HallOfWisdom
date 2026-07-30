import type { HallDatabase } from "./database.js";
import { OwnershipLostError } from "./persistence-errors.js";

interface OwnershipRow {
  owner_token: string;
  epoch: number;
}

/**
 * Runs `fn` inside a short-lived `BEGIN IMMEDIATE` / `COMMIT` transaction,
 * rolling back and rethrowing on any error — the one place transaction
 * boundaries are drawn for the whole persistence layer, so every
 * repository method that needs "validate transition, write the record,
 * write its associated event, all-or-nothing" gets it from the same
 * primitive. `BEGIN IMMEDIATE` (not a bare `BEGIN`) acquires the write
 * lock up front rather than lazily on the first write, which is what
 * makes a losing concurrent writer fail fast with `SQLITE_BUSY` (bounded
 * by the database's own `busy_timeout`) instead of deadlocking against a
 * transaction that already holds a read lock.
 *
 * `fn` must be synchronous and fast — `DatabaseSync` is synchronous by
 * construction, so nothing here could `await` mid-transaction even if it
 * tried; this is a deliberate design constraint of the whole persistence
 * layer (see the Phase 13 kickoff's "because DatabaseSync is synchronous"
 * section), not an oversight.
 *
 * **Phase 13.2 — durable ownership fencing.** Every durable writer in this
 * codebase goes through this one function (never a per-repository
 * ownership check — see this phase's kickoff), so it is the single place
 * the fence is enforced. If `db.ownershipFence` has been set (see
 * `HallDatabase.setOwnershipFence`, called once at startup right after
 * `acquireDatabaseEpoch` succeeds), every transaction re-reads
 * `durable_ownership` *inside* the same `BEGIN IMMEDIATE` boundary as the
 * mutation it's about to perform and confirms the row still matches this
 * process's token/epoch before `fn` runs at all. Because `BEGIN IMMEDIATE`
 * takes SQLite's write lock up front, this read and the mutation that
 * follows it are atomic with respect to any other writer — including a
 * legitimate new owner's own epoch-bump transaction — so there is no gap
 * in which a stale owner's mutation could sneak in between the check and
 * the write. A mismatch throws `OwnershipLostError`, which the existing
 * catch below rolls back and rethrows exactly like any other failure: `fn`
 * never runs, nothing is written, no in-memory projection is touched, and
 * (since publication always happens strictly after a successful store
 * write throughout this codebase) no event is ever published for a
 * rejected mutation.
 *
 * Before the fence is set (ephemeral mode, migrations, and the
 * epoch-acquisition transaction itself, which is what *creates* the fence
 * this checks) this function behaves exactly as it always has —
 * unfenced. Read-only queries never call this function at all and are
 * deliberately never fenced — see
 * `docs/architecture/0013-durable-persistence-and-recovery.md`, "Database
 * fencing," for why a displaced instance is allowed to keep serving
 * (harmlessly stale) reads.
 */
/**
 * Phase 14 — nesting depth per open connection, tracked outside
 * `HallDatabase` itself so its public surface stays exactly what Phase 13
 * shipped. A depth of 0 means "no open transaction on this connection";
 * `withTransaction` calls at depth 0 behave byte-for-byte as they always
 * have. This exists because the CEO plan delegation coordinator
 * (`ceo-plans/ceo-plan-orchestrator.ts`) must write across three existing
 * stores (task creation, plan/delegation-link/event records, the board
 * audit message) as one atomic, fenced unit — and every one of those
 * stores' own public methods already opens its own `withTransaction`.
 * SQLite has no nested `BEGIN`, so a call made while a transaction is
 * already open on this connection participates in it via `SAVEPOINT`
 * instead of starting a new one.
 */
const transactionDepth = new WeakMap<HallDatabase, number>();

function withNestedTransaction<T>(db: HallDatabase, depth: number, fn: () => T): T {
  const savepoint = `sp_${String(depth)}`;
  db.exec(`SAVEPOINT ${savepoint};`);
  transactionDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(`RELEASE SAVEPOINT ${savepoint};`);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint};`);
      db.exec(`RELEASE SAVEPOINT ${savepoint};`);
    } catch {
      // The outermost transaction's own catch below has already rolled
      // everything back (e.g. the connection lost its write lock) — the
      // original `error` is what matters and is always rethrown regardless.
    }
    throw error;
  } finally {
    transactionDepth.set(db, depth);
  }
}

export function withTransaction<T>(db: HallDatabase, fn: () => T): T {
  const depth = transactionDepth.get(db) ?? 0;
  if (depth > 0) {
    // Already inside an outer `withTransaction` on this same connection —
    // the fence was already verified once when that outer transaction
    // opened, and cannot change mid-transaction (SQLite already holds the
    // write lock), so it is deliberately not re-checked here.
    return withNestedTransaction(db, depth, fn);
  }

  db.exec("BEGIN IMMEDIATE;");
  transactionDepth.set(db, 1);
  try {
    const fence = db.ownershipFence;
    if (fence !== undefined) {
      const current = db
        .prepare("SELECT owner_token, epoch FROM durable_ownership WHERE id = 1")
        .get() as OwnershipRow | undefined;
      if (current?.owner_token !== fence.ownerToken || current.epoch !== fence.epoch) {
        throw new OwnershipLostError();
      }
    }
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // A rollback can itself fail only if the transaction was already
      // implicitly rolled back by SQLite (e.g. after certain constraint
      // violations) — the original `error` is what matters and is always
      // rethrown below regardless.
    }
    throw error;
  } finally {
    transactionDepth.set(db, 0);
  }
}
