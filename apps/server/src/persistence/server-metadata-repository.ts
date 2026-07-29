import type { HallDatabase } from "./database.js";
import { ConfigurationFingerprintMismatchError } from "./persistence-errors.js";
import { withTransaction } from "./transaction.js";

const WORKSPACE_ROOT_KEY = "configFingerprint.workspaceRoot";
const COMPARISON_ROOT_KEY = "configFingerprint.comparisonRoot";

function getValue(db: HallDatabase, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM server_metadata WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value;
}

function setValue(db: HallDatabase, key: string, value: string): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO server_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  });
}

export interface ConfigurationFingerprint {
  readonly workspaceRoot: string;
  readonly comparisonRoot: string | undefined;
}

/**
 * Fails closed if this data directory was previously used with different
 * canonical `workspaceRoot`/`comparisonRoot` values than this startup was
 * given — a durable database is scoped to the roots it was created for, so
 * silently reusing it against different roots would let every persisted
 * task working directory, source-repository path, and worktree path
 * silently point outside the boundary this startup actually validated. On
 * a brand-new data directory (no fingerprint recorded yet), records the
 * current roots instead of comparing.
 */
export function checkOrRecordConfigurationFingerprint(
  db: HallDatabase,
  fingerprint: ConfigurationFingerprint,
): void {
  const storedWorkspaceRoot = getValue(db, WORKSPACE_ROOT_KEY);
  const storedComparisonRoot = getValue(db, COMPARISON_ROOT_KEY);

  if (storedWorkspaceRoot === undefined) {
    setValue(db, WORKSPACE_ROOT_KEY, fingerprint.workspaceRoot);
    if (fingerprint.comparisonRoot !== undefined) {
      setValue(db, COMPARISON_ROOT_KEY, fingerprint.comparisonRoot);
    }
    return;
  }

  if (storedWorkspaceRoot !== fingerprint.workspaceRoot) {
    throw new ConfigurationFingerprintMismatchError("workspaceRoot");
  }
  // A previously-recorded comparisonRoot must still match; a startup that
  // now omits comparisons entirely (no comparisonRoot supplied) is allowed
  // — comparisons endpoints are simply unavailable, not a fingerprint
  // conflict — but supplying a *different* comparisonRoot than what this
  // database was created for is rejected the same as a workspaceRoot
  // mismatch.
  if (
    storedComparisonRoot !== undefined &&
    fingerprint.comparisonRoot !== undefined &&
    storedComparisonRoot !== fingerprint.comparisonRoot
  ) {
    throw new ConfigurationFingerprintMismatchError("comparisonRoot");
  }
  if (storedComparisonRoot === undefined && fingerprint.comparisonRoot !== undefined) {
    setValue(db, COMPARISON_ROOT_KEY, fingerprint.comparisonRoot);
  }
}
