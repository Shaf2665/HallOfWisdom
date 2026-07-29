import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isContainedPath } from "@hall-of-wisdom/hall-runner";
import type { CandidateStatus } from "../comparisons/comparison-record.js";
import type { ComparisonStorePort } from "../comparisons/comparison-store-port.js";
import type { ComparisonInternalPathsPort } from "../comparisons/comparison-internal-paths-port.js";
import type { GitWorktreeManager } from "../comparisons/git-worktree-manager.js";

const TERMINAL_CANDIDATE_STATUSES: ReadonlySet<CandidateStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export type WorktreeHealth =
  | "healthy"
  | "interrupted"
  | "workspace_missing"
  | "workspace_unverified"
  | "cleanup_required"
  | "unsafe_path";

/** Deliberately no path field — this is what ends up in `boots.recovery_summary_json` and (eventually) the `/api/v1/system/storage` response; `candidateId` alone is already public (it appears in `AgentComparisonRecord`). */
export interface WorktreeClassification {
  readonly candidateId: string;
  readonly comparisonId: string;
  readonly health: WorktreeHealth;
}

function defaultCaseSensitivity(platform: NodeJS.Platform = os.platform()): boolean {
  return platform !== "win32" && platform !== "darwin";
}

/**
 * Classifies every persisted candidate worktree's on-disk health — never
 * removes, repairs, or touches any worktree; purely diagnostic, for an
 * operator to act on (typically by retrying `DELETE` on the owning
 * comparison). Runs after `reconcileComparisons`, so a candidate's
 * `status`/`terminalEventType` already reflect any interrupted-run outcome
 * that reconciliation pass just recorded — `interruptedCandidateIds` lets
 * this function label those specifically as `"interrupted"` rather than
 * lumping them in with an ordinary completed run's leftover worktree.
 */
export async function classifyComparisonWorktrees(input: {
  readonly internalPaths: ComparisonInternalPathsPort;
  readonly comparisonStore: ComparisonStorePort;
  readonly gitWorktreeManager: GitWorktreeManager;
  readonly interruptedCandidateIds: ReadonlySet<string>;
}): Promise<readonly WorktreeClassification[]> {
  const { worktreePaths } = input.internalPaths.listAll();
  const comparisonRoot = input.gitWorktreeManager.comparisonRoot;
  const containmentOptions = { caseSensitive: defaultCaseSensitivity(), path };
  const results: WorktreeClassification[] = [];

  for (const { candidateId, comparisonId, worktreePath } of worktreePaths) {
    const health = await classifyOne({
      worktreePath,
      candidateId,
      comparisonId,
      comparisonRoot,
      containmentOptions,
      gitWorktreeManager: input.gitWorktreeManager,
      comparisonStore: input.comparisonStore,
      interruptedCandidateIds: input.interruptedCandidateIds,
    });
    results.push({ candidateId, comparisonId, health });
  }
  return results;
}

async function classifyOne(input: {
  readonly worktreePath: string;
  readonly candidateId: string;
  readonly comparisonId: string;
  readonly comparisonRoot: string;
  readonly containmentOptions: { readonly caseSensitive: boolean; readonly path: typeof path };
  readonly gitWorktreeManager: GitWorktreeManager;
  readonly comparisonStore: ComparisonStorePort;
  readonly interruptedCandidateIds: ReadonlySet<string>;
}): Promise<WorktreeHealth> {
  const contained = isContainedPath(
    input.comparisonRoot,
    input.worktreePath,
    input.containmentOptions,
  );
  if (!contained) return "unsafe_path";
  if (!fs.existsSync(input.worktreePath)) return "workspace_missing";

  // `resolveRepositoryRoot` succeeding only proves `worktreePath` is
  // *somewhere inside* a git working tree — `git rev-parse --show-toplevel`
  // walks upward to the nearest ancestor `.git`, so an arbitrary directory
  // sitting under an unrelated ancestor repository (a real possibility on
  // a dev machine whose temp directory itself lives inside a git repo)
  // would otherwise pass this check without ever being a real worktree. A
  // genuine `git worktree add` result is always its OWN toplevel — so this
  // requires the resolved toplevel to equal the canonicalized worktree
  // path itself, not merely resolve to something.
  let canonicalWorktreePath: string;
  try {
    canonicalWorktreePath = fs.realpathSync.native(input.worktreePath);
  } catch {
    return "workspace_missing";
  }
  try {
    const resolvedToplevel = await input.gitWorktreeManager.resolveRepositoryRoot(
      input.worktreePath,
    );
    if (resolvedToplevel !== canonicalWorktreePath) return "workspace_unverified";
  } catch {
    return "workspace_unverified";
  }

  if (input.interruptedCandidateIds.has(input.candidateId)) return "interrupted";

  let candidateStatus: CandidateStatus | undefined;
  try {
    candidateStatus = input.comparisonStore
      .get(input.comparisonId)
      .candidates.find((entry) => entry.candidateId === input.candidateId)?.status;
  } catch {
    candidateStatus = undefined;
  }
  const terminal =
    candidateStatus !== undefined && TERMINAL_CANDIDATE_STATUSES.has(candidateStatus);
  return terminal ? "cleanup_required" : "healthy";
}

/**
 * Count-only scan of `comparisonRoot`'s direct children for directories not
 * backed by any persisted worktree record — never deletes, never returns a
 * name or path, purely a bounded integer for the recovery summary. A
 * missing or unreadable `comparisonRoot` (comparisons never configured, or
 * not yet created) is reported as zero rather than thrown.
 */
export function scanOrphanWorktrees(input: {
  readonly comparisonRoot: string;
  readonly knownWorktreePaths: ReadonlySet<string>;
}): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(input.comparisonRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  let orphanCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidatePath = path.join(input.comparisonRoot, entry.name);
    let canonical: string;
    try {
      canonical = fs.realpathSync.native(candidatePath);
    } catch {
      continue;
    }
    if (!input.knownWorktreePaths.has(canonical)) orphanCount += 1;
  }
  return orphanCount;
}
