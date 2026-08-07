import path from "node:path";
import type { HallDatabase } from "./database.js";
import { ConfigurationFingerprintMismatchError } from "./persistence-errors.js";
import { withTransaction } from "./transaction.js";
import { samePath } from "../agent-worktrees/path-safety.js";

const WORKSPACE_ROOT_KEY = "configFingerprint.workspaceRoot";
const COMPARISON_ROOT_KEY = "configFingerprint.comparisonRoot";
const AGENT_WORKTREE_ROOT_KEY = "configFingerprint.agentWorktreeRoot";

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
  /**
   * Phase 16.5 — canonical Hall-owned agent-worktree root (see
   * `path-safety.ts`'s `canonicalizeHallOwnedRoot`), or `undefined` when
   * isolated agent-worktree execution is not composed this boot.
   */
  readonly agentWorktreeRoot: string | undefined;
}

/**
 * Fails closed if this data directory was previously used with different
 * canonical `workspaceRoot`/`comparisonRoot`/`agentWorktreeRoot` values
 * than this startup was given — a durable database is scoped to the roots
 * it was created for, so silently reusing it against different roots would
 * let every persisted task working directory, source-repository path, and
 * worktree path silently point outside the boundary this startup actually
 * validated. On a brand-new data directory (no fingerprint recorded yet),
 * records the current roots instead of comparing.
 *
 * `agentWorktreeRoot` is deliberately stricter than `comparisonRoot`:
 * `comparisonRoot` may be freely omitted on a later startup once recorded
 * (comparisons simply become unavailable), but `agentWorktreeRoot` may
 * not — Phase 16 restart reconciliation depends on knowing exactly where
 * every persisted worktree lives, and a startup that silently omits a
 * previously-recorded root (an operator typo, a wrong `--agent-worktree-
 * root` flag, or a genuinely different data directory) must never be
 * treated as "isolation is now disabled" rather than a configuration
 * error — that would leave real Git worktrees permanently unreconciled
 * without the operator ever deciding that.
 *
 * The same reasoning applies whenever the database already holds
 * `agent_worktrees` rows but has never durably recorded a root — an
 * interrupted first enablement, a database written by code that predates
 * this fingerprint field, or (the fully missing case) a database where
 * `workspaceRoot` itself was never recorded either yet, so it would
 * otherwise take the brand-new-database bootstrap path below without ever
 * being checked. This is why the root-omission-with-existing-rows check
 * below runs unconditionally, before either the brand-new-database or the
 * existing-database branch, rather than being nested inside the
 * existing-database branch alone: an omitted root here is rejected
 * regardless of whether `workspaceRoot` happens to already be recorded,
 * never silently treated as "isolation was never enabled" — that would
 * compose no agent-worktree manager and skip Phase 16 reconciliation for
 * rows that still durably exist. Never derives a root from those rows'
 * stored paths (see `assertAgentWorktreeRootIdentity`'s own doc comment on
 * why this module never guesses).
 *
 * All validation for one call happens before any write, and every write
 * this call performs happens inside one outer transaction (see
 * `withTransaction`'s nesting behavior) — a failure writing any one key
 * rolls back every key from this same call, never a partial fingerprint.
 */
export function checkOrRecordConfigurationFingerprint(
  db: HallDatabase,
  fingerprint: ConfigurationFingerprint,
): void {
  const storedWorkspaceRoot = getValue(db, WORKSPACE_ROOT_KEY);
  const storedComparisonRoot = getValue(db, COMPARISON_ROOT_KEY);
  const storedAgentWorktreeRoot = getValue(db, AGENT_WORKTREE_ROOT_KEY);

  // Runs first, unconditionally — see this function's doc comment on "the
  // fully missing fingerprint case." Independent of whether workspaceRoot
  // (or anything else) has ever been recorded: the only things that
  // matter are whether a root was ever durably recorded, whether one was
  // supplied this boot, and whether rows already exist that would be
  // silently orphaned by accepting the omission.
  if (
    storedAgentWorktreeRoot === undefined &&
    fingerprint.agentWorktreeRoot === undefined &&
    hasAnyAgentWorktreeRows(db)
  ) {
    throw new ConfigurationFingerprintMismatchError("agentWorktreeRoot");
  }

  if (storedWorkspaceRoot === undefined) {
    // Brand-new database: nothing recorded yet for any field. The
    // omitted-root-with-existing-rows case was already rejected above if
    // applicable; a freshly created database with no rows at all (the
    // ordinary case) or a supplied root both reach here safely. The
    // identity check still runs unconditionally when a root IS supplied,
    // so there is exactly one code path that ever bootstraps
    // `agentWorktreeRoot` — never two subtly different ones.
    if (fingerprint.agentWorktreeRoot !== undefined) {
      assertAgentWorktreeRootIdentity(db, fingerprint.agentWorktreeRoot);
    }
    withTransaction(db, () => {
      setValue(db, WORKSPACE_ROOT_KEY, fingerprint.workspaceRoot);
      if (fingerprint.comparisonRoot !== undefined) {
        setValue(db, COMPARISON_ROOT_KEY, fingerprint.comparisonRoot);
      }
      if (fingerprint.agentWorktreeRoot !== undefined) {
        setValue(db, AGENT_WORKTREE_ROOT_KEY, fingerprint.agentWorktreeRoot);
      }
    });
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

  if (storedAgentWorktreeRoot !== undefined) {
    // Recorded on a prior boot: an omitted or different root both fail
    // closed — see this function's doc comment for why omission is not
    // tolerated here the way it is for comparisonRoot.
    if (
      fingerprint.agentWorktreeRoot === undefined ||
      storedAgentWorktreeRoot !== fingerprint.agentWorktreeRoot
    ) {
      throw new ConfigurationFingerprintMismatchError("agentWorktreeRoot");
    }
  } else if (fingerprint.agentWorktreeRoot !== undefined) {
    // Not yet recorded on an EXISTING database — this may be a legacy
    // database that already has persisted `agent_worktrees` rows from
    // before this fingerprint field existed (or from a database that
    // simply never enabled isolation until now). Never trust a supplied
    // root blindly: prove every persisted worktree's reconstructed
    // `wt_<worktreeId>` path actually belongs to it first.
    assertAgentWorktreeRootIdentity(db, fingerprint.agentWorktreeRoot);
  }
  // The remaining case — storedAgentWorktreeRoot undefined AND
  // fingerprint.agentWorktreeRoot undefined — was already proven safe (no
  // existing rows) by the unconditional check at the top of this
  // function; nothing further to validate here.

  // Writes happen only after every check above has passed, and both keys
  // in this call are written inside one outer transaction — a
  // comparisonRoot conflict must never leave a bootstrapped
  // agentWorktreeRoot behind, and vice versa, and a failure partway
  // through must never leave one key committed and the other not.
  withTransaction(db, () => {
    if (storedComparisonRoot === undefined && fingerprint.comparisonRoot !== undefined) {
      setValue(db, COMPARISON_ROOT_KEY, fingerprint.comparisonRoot);
    }
    if (storedAgentWorktreeRoot === undefined && fingerprint.agentWorktreeRoot !== undefined) {
      setValue(db, AGENT_WORKTREE_ROOT_KEY, fingerprint.agentWorktreeRoot);
    }
  });
}

interface AgentWorktreeIdentityRow {
  readonly worktree_id: string;
  readonly worktree_path: string;
}

/**
 * Reads `agent_worktrees` directly (the same table
 * `sqlite-agent-worktree-store.ts` owns) rather than importing that
 * store's class — this module stays pure SQLite plumbing with no
 * dependency on domain store construction, mirroring every other
 * `*-repository.ts` module's own narrow, table-scoped queries. Never
 * derives or guesses a root from a stored path: the candidate root is
 * always caller-supplied (canonicalized by `canonicalizeHallOwnedRoot`
 * before this function ever sees it), and every persisted row's own
 * `worktree_path` must exactly equal `<candidateRoot>/wt_<worktreeId>` —
 * the identical reconstruction `AgentWorktreeManager` itself uses — or
 * this throws without recording anything. An empty table (no worktree
 * rows at all) trivially passes.
 */
function assertAgentWorktreeRootIdentity(db: HallDatabase, candidateRoot: string): void {
  const rows = db
    .prepare("SELECT worktree_id, worktree_path FROM agent_worktrees")
    .all() as unknown as AgentWorktreeIdentityRow[];
  for (const row of rows) {
    const expectedPath = path.join(candidateRoot, `wt_${row.worktree_id}`);
    if (!samePath(expectedPath, row.worktree_path)) {
      throw new ConfigurationFingerprintMismatchError("agentWorktreeRoot");
    }
  }
}

/** Existence-only check — never reads `worktree_path` or any other column; this function never derives or guesses a root from anything it finds. */
function hasAnyAgentWorktreeRows(db: HallDatabase): boolean {
  const row = db.prepare("SELECT 1 FROM agent_worktrees LIMIT 1").get();
  return row !== undefined;
}
