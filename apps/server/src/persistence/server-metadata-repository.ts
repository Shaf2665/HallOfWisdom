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
 * All validation for one call happens before any write — see
 * "no partial fingerprint writes" below.
 */
export function checkOrRecordConfigurationFingerprint(
  db: HallDatabase,
  fingerprint: ConfigurationFingerprint,
): void {
  const storedWorkspaceRoot = getValue(db, WORKSPACE_ROOT_KEY);
  const storedComparisonRoot = getValue(db, COMPARISON_ROOT_KEY);
  const storedAgentWorktreeRoot = getValue(db, AGENT_WORKTREE_ROOT_KEY);

  if (storedWorkspaceRoot === undefined) {
    // Brand-new database: nothing recorded yet for any field. A freshly
    // created database cannot yet hold any `agent_worktrees` rows, but the
    // identity check still runs unconditionally so there is exactly one
    // code path that ever bootstraps `agentWorktreeRoot` — never two
    // subtly different ones.
    if (fingerprint.agentWorktreeRoot !== undefined) {
      assertAgentWorktreeRootIdentity(db, fingerprint.agentWorktreeRoot);
    }
    setValue(db, WORKSPACE_ROOT_KEY, fingerprint.workspaceRoot);
    if (fingerprint.comparisonRoot !== undefined) {
      setValue(db, COMPARISON_ROOT_KEY, fingerprint.comparisonRoot);
    }
    if (fingerprint.agentWorktreeRoot !== undefined) {
      setValue(db, AGENT_WORKTREE_ROOT_KEY, fingerprint.agentWorktreeRoot);
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

  // Writes happen only after every check above has passed — a
  // comparisonRoot conflict must never leave a bootstrapped
  // agentWorktreeRoot behind, and vice versa.
  if (storedComparisonRoot === undefined && fingerprint.comparisonRoot !== undefined) {
    setValue(db, COMPARISON_ROOT_KEY, fingerprint.comparisonRoot);
  }
  if (storedAgentWorktreeRoot === undefined && fingerprint.agentWorktreeRoot !== undefined) {
    setValue(db, AGENT_WORKTREE_ROOT_KEY, fingerprint.agentWorktreeRoot);
  }
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
