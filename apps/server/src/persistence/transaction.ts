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
export function withTransaction<T>(db: HallDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
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
  }
}
