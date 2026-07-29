import type { HallDatabase } from "./database.js";
import { withTransaction } from "./transaction.js";

export interface BootRow {
  readonly bootId: string;
  readonly startedAt: string;
  readonly readyAt: string | undefined;
  readonly shutdownInitiatedAt: string | undefined;
  readonly cleanShutdownAt: string | undefined;
  readonly recoverySummaryJson: string | undefined;
}

interface RawBootRow {
  boot_id: string;
  started_at: string;
  ready_at: string | null;
  shutdown_initiated_at: string | null;
  clean_shutdown_at: string | null;
  recovery_summary_json: string | null;
}

function toBootRow(row: RawBootRow): BootRow {
  return {
    bootId: row.boot_id,
    startedAt: row.started_at,
    readyAt: row.ready_at ?? undefined,
    shutdownInitiatedAt: row.shutdown_initiated_at ?? undefined,
    cleanShutdownAt: row.clean_shutdown_at ?? undefined,
    recoverySummaryJson: row.recovery_summary_json ?? undefined,
  };
}

/**
 * One row per Hall Core process lifetime, in strict startup order (`rowid`,
 * never `started_at` — two boots issued within the same millisecond are
 * still ordered correctly by insertion, which a timestamp cannot guarantee).
 * `restart-recovery.ts` reads the most recent PRIOR boot (before inserting
 * this one) to decide whether the previous shutdown was clean; `server.ts`
 * marks `readyAt` once startup completes and `cleanShutdownAt` only on a
 * graceful shutdown path — a boot with no `cleanShutdownAt` is exactly what
 * the next startup's recovery treats as "unclean."
 */
export function recordBootStarted(db: HallDatabase, bootId: string, startedAt: string): void {
  withTransaction(db, () => {
    db.prepare("INSERT INTO boots (boot_id, started_at) VALUES (?, ?)").run(bootId, startedAt);
  });
}

export function recordBootReady(db: HallDatabase, bootId: string, readyAt: string): void {
  withTransaction(db, () => {
    db.prepare("UPDATE boots SET ready_at = ? WHERE boot_id = ?").run(readyAt, bootId);
  });
}

export function recordShutdownInitiated(db: HallDatabase, bootId: string, timestamp: string): void {
  withTransaction(db, () => {
    db.prepare("UPDATE boots SET shutdown_initiated_at = ? WHERE boot_id = ?").run(
      timestamp,
      bootId,
    );
  });
}

/**
 * Fenced like every other durable write — a former owner whose epoch has
 * been superseded gets `OwnershipLostError` here exactly as it would for
 * any other mutation, which is precisely what guarantees a displaced
 * instance can never write a clean-shutdown marker under a lost epoch
 * (this phase's kickoff, §3): the caller's existing `try`/`catch` around
 * this call (see `server.ts`) already tolerates any thrown error by
 * simply logging and continuing shutdown, so no new handling is needed
 * here.
 */
export function recordCleanShutdown(db: HallDatabase, bootId: string, timestamp: string): void {
  withTransaction(db, () => {
    db.prepare("UPDATE boots SET clean_shutdown_at = ? WHERE boot_id = ?").run(timestamp, bootId);
  });
}

export function recordRecoverySummary(db: HallDatabase, bootId: string, summaryJson: string): void {
  withTransaction(db, () => {
    db.prepare("UPDATE boots SET recovery_summary_json = ? WHERE boot_id = ?").run(
      summaryJson,
      bootId,
    );
  });
}

/** The most recent boot row strictly before `excludingBootId`, or `undefined` if this is the first boot ever recorded against this database. */
export function getPreviousBoot(db: HallDatabase, excludingBootId: string): BootRow | undefined {
  const row = db
    .prepare(`SELECT * FROM boots WHERE boot_id != ? ORDER BY rowid DESC LIMIT 1`)
    .get(excludingBootId) as RawBootRow | undefined;
  return row !== undefined ? toBootRow(row) : undefined;
}
