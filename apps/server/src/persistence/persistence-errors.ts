/**
 * Local error hierarchy for the persistence layer — deliberately not
 * `HallCoreError`-derived (same layering `git-worktree-errors.ts` uses
 * relative to the comparison orchestrator): this module has no knowledge of
 * HTTP status codes. Callers (recovery, composition) catch these and
 * rewrap them into bounded, path-free, SQL-free diagnostics before
 * anything reaches a log line an operator reads or (never) an HTTP
 * response. Every message here is safe to log locally but must never be
 * forwarded verbatim to a route.
 */
export abstract class PersistenceError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** `dataDir` failed validation (not absolute, escapes a protected root, resolves through a symlink, etc.) — never includes the rejected path in a message a route could forward. */
export class DataDirValidationError extends PersistenceError {
  constructor(reason: string) {
    super(`Data directory is invalid: ${reason}`);
  }
}

/** A migration failed partway through — the transaction was rolled back, so the schema version on disk is unchanged. */
export class MigrationFailedError extends PersistenceError {
  constructor(version: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Migration ${String(version)} failed and was rolled back: ${detail}`);
  }
}

/** The database's recorded schema version is newer than this build of Hall Core understands — fail closed rather than guess. */
export class UnsupportedSchemaVersionError extends PersistenceError {
  constructor(foundVersion: number, highestKnownVersion: number) {
    super(
      `Database schema version ${String(foundVersion)} is newer than the highest version this build supports (${String(highestKnownVersion)}). Refusing to start against it.`,
    );
  }
}

/** A row read back from storage failed re-validation against its own domain Zod schema — the database is trusted for structure, never for content. */
export class CorruptRecordError extends PersistenceError {
  constructor(table: string, id: string, detail: string) {
    super(`Corrupt record in "${table}" (id "${id}"): ${detail}`);
  }
}

/** The database's stored configuration fingerprint (workspaceRoot/comparisonRoot) does not match the roots this startup was given. */
export class ConfigurationFingerprintMismatchError extends PersistenceError {
  constructor(field: string) {
    super(
      `Stored configuration fingerprint does not match this startup's ${field} — refusing to start against a database created for a different root.`,
    );
  }
}

/** A mutating repository method was called after the underlying database connection was closed. */
export class DatabaseClosedError extends PersistenceError {
  constructor() {
    super("The database connection has already been closed.");
  }
}

/**
 * Another Hall Core process already owns this `--data-dir` (or the
 * ownership record could not be safely confirmed dead) — see
 * `instance-ownership.ts`. Deliberately never includes the data
 * directory path, the lock file path, or the competing process's PID —
 * this error's message is safe to log and safe to surface in a CLI exit
 * diagnostic verbatim.
 */
export class InstanceOwnershipConflictError extends PersistenceError {
  constructor(reason: string) {
    super(`Another Hall Core instance already owns this data directory (${reason}).`);
  }
}

/**
 * A fenced transaction (`withTransaction`) re-checked the durable
 * ownership epoch inside its own `BEGIN IMMEDIATE`/`COMMIT` boundary and
 * found this process's owner token/epoch no longer matches the row in
 * `durable_ownership` — another instance has since taken over. The
 * transaction was rolled back before this error was thrown; nothing it
 * attempted to write was committed. See
 * `docs/architecture/0013-durable-persistence-and-recovery.md`, "Database
 * fencing." Callers must treat this as a signal to stop mutating and begin
 * controlled shutdown, never retry the same mutation.
 */
export class OwnershipLostError extends PersistenceError {
  constructor() {
    super(
      "This instance's durable ownership epoch has been superseded by another instance; the mutation was rolled back.",
    );
  }
}
