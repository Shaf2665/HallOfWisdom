import { randomUUID } from "node:crypto";
import { HallDatabase, type OwnershipFence } from "./database.js";
import { runMigrations } from "./migration-runner.js";
import { acquireInstanceOwnership, type InstanceOwnershipHandle } from "./instance-ownership.js";
import { acquireDatabaseEpoch } from "./database-ownership-fence.js";

export interface OpenDurableStorageOptions {
  /** Canonical, already-validated `dataDir` (see `database-config.ts`'s `resolveDataDir`) — this function performs no validation of its own. */
  readonly dataDir: string;
  readonly bootId: string;
  readonly busyTimeoutMs: number;
}

export interface OpenDurableStorageResult {
  readonly db: HallDatabase;
  readonly ownershipHandle: InstanceOwnershipHandle;
  readonly ownershipFence: OwnershipFence;
}

/**
 * The complete durable-mode acquisition sequence (Phase 13.2 kickoff §2):
 * acquire the filesystem ownership lock, open the database, run
 * migrations, acquire the database ownership epoch, and set it as `db`'s
 * active fence — in that order, before any recovery or request handling
 * begins. Every durable Hall Core entry point calls exactly this
 * function rather than reimplementing the sequence: production
 * (`server.ts`) and the E2E dual-fixture composition
 * (`apps/e2e/src/fixture-server.ts`) both do, which is what guarantees
 * the E2E fencing coverage exercises the real mechanism rather than a
 * parallel copy that could silently drift from it.
 *
 * On any failure after the filesystem lock has been acquired, cleans up
 * everything already opened (closes `db` if it was opened, releases the
 * ownership lock) before rethrowing the original error — callers never
 * need to track partial initialization state themselves.
 */
export function openDurableStorage(options: OpenDurableStorageOptions): OpenDurableStorageResult {
  const ownerToken = randomUUID();
  const ownershipHandle = acquireInstanceOwnership({
    dataDir: options.dataDir,
    bootId: options.bootId,
    token: ownerToken,
  });

  let db: HallDatabase | undefined;
  try {
    db = HallDatabase.open({ dataDir: options.dataDir, busyTimeoutMs: options.busyTimeoutMs });
    runMigrations(db);
    const ownershipFence = acquireDatabaseEpoch(db, ownerToken);
    db.setOwnershipFence(ownershipFence);
    return { db, ownershipHandle, ownershipFence };
  } catch (error) {
    db?.close();
    ownershipHandle.release();
    throw error;
  }
}
