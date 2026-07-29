import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DatabaseClosedError } from "./persistence-errors.js";

export const DATABASE_FILE_NAME = "hall-core.db";

const DEFAULT_BUSY_TIMEOUT_MS = 2000;

/**
 * Thin wrapper around `node:sqlite`'s `DatabaseSync` — the *only* file in
 * this package allowed to import `node:sqlite` directly (every domain
 * repository depends on this class's narrow surface, never on the raw
 * module). Deliberately minimal: a bounded busy timeout, `foreign_keys`
 * enforcement, extension loading left off (never enabled — `node:sqlite`'s
 * default), and idempotent `close()`.
 *
 * One connection per Hall Core instance — see
 * `docs/architecture/0013-durable-persistence-and-recovery.md`, "Database
 * lifecycle."
 */
export interface OwnershipFence {
  readonly ownerToken: string;
  readonly epoch: number;
}

export class HallDatabase {
  readonly #db: DatabaseSync;
  readonly #filePath: string | undefined;
  #closed = false;
  #ownershipFence: OwnershipFence | undefined;

  private constructor(location: string, filePath: string | undefined, busyTimeoutMs: number) {
    this.#filePath = filePath;
    this.#db = new DatabaseSync(location, { open: true });
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.#db.exec(`PRAGMA busy_timeout = ${String(Math.trunc(busyTimeoutMs))};`);
  }

  /** Opens (creating if missing) the real on-disk database under `dataDir` — production and durable-mode tests. */
  static open(options: { readonly dataDir: string; readonly busyTimeoutMs: number }): HallDatabase {
    const filePath = path.join(options.dataDir, DATABASE_FILE_NAME);
    return new HallDatabase(filePath, filePath, options.busyTimeoutMs);
  }

  /** Opens a private, non-file-backed database — used only by tests that need real SQLite semantics without touching disk. */
  static openInMemory(busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS): HallDatabase {
    return new HallDatabase(":memory:", undefined, busyTimeoutMs);
  }

  /** Never exposed outside the persistence layer — see `database-config.ts`'s doc comment on why the data directory (and therefore this path) must never reach a route. `undefined` for an in-memory test database. */
  get filePath(): string | undefined {
    return this.#filePath;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Set exactly once at startup, immediately after `acquireDatabaseEpoch`
   * succeeds (see `database-ownership-fence.ts` and `server.ts`) — before
   * this is set, `withTransaction` performs no fence check at all, which
   * is what lets migrations and the epoch-acquisition transaction itself
   * run unfenced (they are what *create* the fence). Once set, every
   * subsequent `withTransaction` call re-verifies this token/epoch still
   * matches `durable_ownership` inside its own transaction. Never reset
   * back to `undefined` — a displaced instance stays fenced (and
   * therefore harmless) for the rest of its process lifetime.
   */
  setOwnershipFence(fence: OwnershipFence): void {
    this.#ownershipFence = fence;
  }

  /** `undefined` until `setOwnershipFence` has been called (ephemeral mode never calls it at all, since there is no `HallDatabase` in that mode). */
  get ownershipFence(): OwnershipFence | undefined {
    return this.#ownershipFence;
  }

  prepare(sql: string): StatementSync {
    if (this.#closed) throw new DatabaseClosedError();
    return this.#db.prepare(sql);
  }

  exec(sql: string): void {
    if (this.#closed) throw new DatabaseClosedError();
    this.#db.exec(sql);
  }

  /** Idempotent — a second call is a safe no-op, never a thrown error, so shutdown code never needs to track whether it already closed. */
  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
