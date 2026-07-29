import type { HallDatabase, OwnershipFence } from "./database.js";
import { withTransaction } from "./transaction.js";

interface OwnershipRow {
  owner_token: string;
  epoch: number;
}

/**
 * Establishes this process's durable ownership epoch — must be called
 * once at startup, after `runMigrations` and before
 * `db.setOwnershipFence()` (see `server.ts`'s startup ordering and this
 * phase's kickoff, requirement #2's acquisition policy). Reads the
 * current epoch (if any — a brand-new database has no row yet), and
 * durably records this owner's token against `current epoch + 1`, all
 * inside one `withTransaction` call. This transaction is itself unfenced:
 * it runs before `setOwnershipFence` has been called on `db`, and it is
 * what *creates* the fence a later transaction would check — there is
 * nothing to verify against yet.
 *
 * By the time this returns, any previous owner's next fenced write will
 * see this new epoch and be rejected — see `transaction.ts`'s doc
 * comment for why `BEGIN IMMEDIATE` makes the epoch bump the atomic
 * linearization point between the old and new owner.
 */
export function acquireDatabaseEpoch(db: HallDatabase, ownerToken: string): OwnershipFence {
  return withTransaction(db, () => {
    const current = db
      .prepare("SELECT owner_token, epoch FROM durable_ownership WHERE id = 1")
      .get() as OwnershipRow | undefined;
    const epoch = (current?.epoch ?? 0) + 1;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO durable_ownership (id, owner_token, epoch, acquired_at, heartbeat_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_token = excluded.owner_token,
         epoch = excluded.epoch,
         acquired_at = excluded.acquired_at,
         heartbeat_at = excluded.heartbeat_at`,
    ).run(ownerToken, epoch, now, now);
    return { ownerToken, epoch };
  });
}

/**
 * Read-only, deliberately unfenced (see `transaction.ts`'s doc comment on
 * read policy) — used by the heartbeat monitor (`ownership-fence-monitor.ts`)
 * to proactively detect that another instance has taken over, and by
 * tests. Never returns the row to a route or WebSocket message.
 */
export function readCurrentDatabaseOwnership(db: HallDatabase): OwnershipFence | undefined {
  const row = db.prepare("SELECT owner_token, epoch FROM durable_ownership WHERE id = 1").get() as
    OwnershipRow | undefined;
  return row !== undefined ? { ownerToken: row.owner_token, epoch: row.epoch } : undefined;
}

/**
 * Best-effort diagnostic refresh of `heartbeat_at` — never part of the
 * staleness or fencing decision itself (only `owner_token`/`epoch` are
 * ever compared). Silently does nothing if this instance's epoch has
 * already been superseded, since a stale-owner refresh must never
 * resurrect a lost fence; the caller's heartbeat monitor is what notices
 * the mismatch and reacts, not this function.
 */
export function touchDatabaseOwnershipHeartbeat(db: HallDatabase, fence: OwnershipFence): void {
  db.prepare(
    `UPDATE durable_ownership
     SET heartbeat_at = ?
     WHERE id = 1 AND owner_token = ? AND epoch = ?`,
  ).run(new Date().toISOString(), fence.ownerToken, fence.epoch);
}
