import type { HallDatabase, OwnershipFence } from "./database.js";
import {
  readCurrentDatabaseOwnership,
  touchDatabaseOwnershipHeartbeat,
} from "./database-ownership-fence.js";

const DEFAULT_MONITOR_INTERVAL_MS = 2000;

export interface OwnershipFenceMonitorHandle {
  /** Idempotent, safe to call even after the monitor has already fired or stopped itself. */
  stop(): void;
}

export interface OwnershipFenceMonitorOptions {
  readonly db: HallDatabase;
  readonly fence: OwnershipFence;
  readonly intervalMs?: number;
  readonly onOwnershipLost: () => void;
}

/**
 * Proactive, best-effort detection layered *on top of* the authoritative
 * per-transaction fence in `transaction.ts` — this exists only so a
 * displaced instance notices and begins controlled shutdown sooner than
 * "the next time it happens to attempt a durable write." It is never
 * itself the correctness guarantee (kickoff §4; see `transaction.ts`'s
 * doc comment for why the per-transaction check is what actually matters).
 * `touchDatabaseOwnershipHeartbeat` here is diagnostic only — refreshing
 * `heartbeat_at` never influences the fence comparison itself, which only
 * ever compares `owner_token`/`epoch`.
 *
 * Deliberately a *separate* timer from `instance-ownership.ts`'s
 * filesystem-lock heartbeat rather than folded into it — that module has
 * no knowledge of `HallDatabase` and is constructed before the database
 * even opens, and this phase's kickoff frames the filesystem lock and the
 * database fence as two distinct layers (see
 * `docs/architecture/0013-durable-persistence-and-recovery.md`, "Filesystem
 * lock versus database fence"). Both timers are `unref()`d and both are
 * cleaned up by their own explicit `stop()`/`release()` during shutdown.
 */
export function startOwnershipFenceMonitor(
  options: OwnershipFenceMonitorOptions,
): OwnershipFenceMonitorHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    try {
      touchDatabaseOwnershipHeartbeat(options.db, options.fence);
      const current = readCurrentDatabaseOwnership(options.db);
      const stillOwner =
        current?.ownerToken === options.fence.ownerToken && current.epoch === options.fence.epoch;
      if (!stillOwner) {
        stopped = true;
        clearInterval(timer);
        options.onOwnershipLost();
      }
    } catch {
      // Best-effort: a single failed tick (e.g. the database connection
      // was already closed by a shutdown already in progress) must never
      // crash the process or itself be mistaken for ownership loss.
    }
  }, intervalMs);
  timer.unref();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
