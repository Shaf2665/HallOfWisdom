import type { HallDatabase } from "./database.js";
import { withTransaction } from "./transaction.js";
import { MIGRATIONS, HIGHEST_KNOWN_SCHEMA_VERSION } from "./migrations.js";
import { MigrationFailedError, UnsupportedSchemaVersionError } from "./persistence-errors.js";

const SCHEMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`;

function currentSchemaVersion(db: HallDatabase): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    { version: number | null } | undefined;
  return row?.version ?? 0;
}

/**
 * Applies every migration in `MIGRATIONS` newer than the database's
 * current recorded version, in order, each inside its own transaction —
 * a `schema_migrations` row is inserted only after that migration's `up`
 * has fully succeeded, so a failure partway through a migration leaves
 * the prior schema version intact (the transaction rolls back the DDL
 * too, not just data). Running this against an already-fully-migrated
 * database is a safe no-op. A database whose recorded version is *higher*
 * than `HIGHEST_KNOWN_SCHEMA_VERSION` (this build is older than the
 * database) fails closed rather than guessing at compatibility.
 */
export function runMigrations(db: HallDatabase): void {
  db.exec(SCHEMA_MIGRATIONS_TABLE_SQL);

  const startingVersion = currentSchemaVersion(db);
  if (startingVersion > HIGHEST_KNOWN_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(startingVersion, HIGHEST_KNOWN_SCHEMA_VERSION);
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > startingVersion).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    try {
      withTransaction(db, () => {
        migration.up(db);
        db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
          migration.version,
          new Date().toISOString(),
        );
      });
    } catch (error) {
      throw new MigrationFailedError(migration.version, error);
    }
  }
}
