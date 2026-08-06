import fs from "node:fs";
import path from "node:path";
import { isTerminalEventType, type TerminalEventType } from "@hall-of-wisdom/hall-runner";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import type { AgentWorktreeManager } from "../agent-worktrees/agent-worktree-manager.js";
import type { AgentWorktreeRecord } from "../agent-worktrees/agent-worktree-record.js";
import type { AgentWorktreeStorePort } from "../agent-worktrees/agent-worktree-store-port.js";
import { isPathContained } from "../agent-worktrees/path-safety.js";
import type { NormalizedEventStorePort } from "../events/event-store-port.js";
import type { AgentExecutionArtifactStorePort } from "../execution-artifacts/agent-execution-artifact-store-port.js";
import type { AgentExecutionArtifactTerminalizer } from "../agent-execution/agent-execution-artifact-terminalizer.js";
import type { AgentExecutionTerminalSnapshot } from "../agent-execution/agent-execution-terminal-snapshot.js";

export const RESTART_INTERRUPTED_WORKTREE_CREATION_CODE =
  "HALL_RESTART_INTERRUPTED_WORKTREE_CREATION";

/** The one directory the manager itself creates under the owned root that is never a worktree — see `agent-worktree-manager.ts`'s `canonicalizeEmptyHooksDirectory`. */
const HALL_CONTROLLED_NON_WORKTREE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "_hall_empty_hooks",
]);

export interface AgentWorktreeReconciliationInput {
  readonly agentWorktreeStore: AgentWorktreeStorePort;
  readonly agentWorktreeManager: AgentWorktreeManager;
  /** Canonical Hall-owned worktree root — see `path-safety.ts`'s `canonicalizeHallOwnedRoot`. */
  readonly agentWorktreeRoot: string;
  readonly taskEventStore: NormalizedEventStorePort;
  readonly agentExecutionArtifactStore: AgentExecutionArtifactStorePort;
  readonly agentExecutionArtifactTerminalizer: AgentExecutionArtifactTerminalizer;
  readonly now?: (() => string) | undefined;
}

export interface AgentWorktreeReconciliationSummary {
  readonly worktreesScanned: number;
  readonly interruptedCreationCount: number;
  readonly artifactsRecovered: number;
  readonly artifactsConfirmed: number;
  readonly cleanupAttempts: number;
  readonly worktreesCleaned: number;
  readonly cleanupFailures: number;
  readonly reconciliationBlockedCount: number;
  /** A `cleaned` record whose filesystem directory unexpectedly exists again. Never auto-deleted; never transitions the record backward. */
  readonly inconsistentCleanedDirectoryCount: number;
  /** A `cleaned` record whose Git worktree registration unexpectedly exists again. Never auto-pruned; never transitions the record backward. */
  readonly inconsistentCleanedRegistrationCount: number;
  /** A directory (or symlink/junction) under the owned root not backed by any persisted worktree record. Counted, never deleted or pruned. */
  readonly orphanWorktreeDirectoryCount: number;
  /** A Git worktree registration under the owned root not backed by any persisted worktree record. Counted, never deleted or pruned — Git registrations are never mutated by this pass. */
  readonly orphanWorktreeRegistrationCount: number;
  /**
   * The owned root's filesystem could not be listed, or a source
   * repository's Git worktree registrations could not be inspected
   * (including truncated Git output) — a bounded failure count, never a
   * silent zero standing in for "nothing to report."
   */
  readonly registrationInspectionFailureCount: number;
}

const EMPTY_SUMMARY: AgentWorktreeReconciliationSummary = {
  worktreesScanned: 0,
  interruptedCreationCount: 0,
  artifactsRecovered: 0,
  artifactsConfirmed: 0,
  cleanupAttempts: 0,
  worktreesCleaned: 0,
  cleanupFailures: 0,
  reconciliationBlockedCount: 0,
  inconsistentCleanedDirectoryCount: 0,
  inconsistentCleanedRegistrationCount: 0,
  orphanWorktreeDirectoryCount: 0,
  orphanWorktreeRegistrationCount: 0,
  registrationInspectionFailureCount: 0,
};

/**
 * Phase 16.5 — the agent-worktree mirror of `reconcileTasks`/
 * `reconcileComparisons`: runs unconditionally on every durable startup
 * (never gated on "previous shutdown was unclean"), keyed off each
 * worktree's own currently-persisted status, so a second consecutive
 * unclean restart is a no-op for anything the first pass already
 * reconciled. Must run strictly AFTER `reconcileTasks` in the same boot:
 * that pass is what turns a genuinely mid-flight run's non-terminal event
 * stream into a terminal one (a synthetic `run.failed` carrying
 * `HALL_RESTART_INTERRUPTED_RUN`) — this function never synthesizes a
 * terminal outcome itself, it only ever looks for one that already exists.
 *
 * Never deletes a worktree except through `AgentWorktreeManager
 * .cleanupWorktree`, which owns every safety check (safe-id
 * reconstruction, symlink/junction rejection, mutual root containment,
 * `git worktree remove --force` only, mark-cleaned-if-both-absent) — this
 * function only ever decides WHETHER and WHEN to call it, never how.
 */
export async function reconcileAgentWorktrees(
  input: AgentWorktreeReconciliationInput,
): Promise<AgentWorktreeReconciliationSummary> {
  const records = input.agentWorktreeStore.list();
  if (records.length === 0) {
    const filesystem = scanOrphans(input, []);
    return {
      ...EMPTY_SUMMARY,
      orphanWorktreeDirectoryCount: filesystem.orphanCount,
      registrationInspectionFailureCount: filesystem.inspectionFailed ? 1 : 0,
    };
  }

  let interruptedCreationCount = 0;
  let artifactsRecovered = 0;
  let artifactsConfirmed = 0;
  let cleanupAttempts = 0;
  let worktreesCleaned = 0;
  let cleanupFailures = 0;
  let reconciliationBlockedCount = 0;
  let inconsistentCleanedDirectoryCount = 0;

  for (const initial of records) {
    try {
      switch (initial.status) {
        case "creating": {
          interruptedCreationCount += 1;
          const marked = markInterruptedCreation(input, initial);
          const result = await runCleanup(input, marked.worktreeId);
          cleanupAttempts += 1;
          if (result === "cleaned") worktreesCleaned += 1;
          else cleanupFailures += 1;
          break;
        }
        case "creation_failed":
        case "cleanup_pending":
        case "cleanup_failed": {
          const result = await runCleanup(input, initial.worktreeId);
          cleanupAttempts += 1;
          if (result === "cleaned") worktreesCleaned += 1;
          else cleanupFailures += 1;
          break;
        }
        case "ready": {
          const outcome = await reconcileReadyWorktree(input, initial);
          if (outcome === "blocked") {
            reconciliationBlockedCount += 1;
            break;
          }
          if (outcome === "artifact_recovered") artifactsRecovered += 1;
          else artifactsConfirmed += 1;
          const result = await runCleanup(input, initial.worktreeId);
          cleanupAttempts += 1;
          if (result === "cleaned") worktreesCleaned += 1;
          else cleanupFailures += 1;
          break;
        }
        case "cleaned": {
          if (cleanedRecordLooksInconsistent(initial)) inconsistentCleanedDirectoryCount += 1;
          break;
        }
        default:
          break;
      }
    } catch (error) {
      // Recovery runs before the server accepts a single request — an
      // unexpected failure reconciling ONE worktree must never brick
      // startup, and must never be treated as license to clean up or
      // fabricate anything for that record. Fail closed: leave it exactly
      // as found and report it as blocked.
      reconciliationBlockedCount += 1;
      console.error(
        `Recovery could not reconcile agent worktree "${initial.worktreeId}"; leaving it untouched: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Deterministic, batched, read-only passes over the ORIGINAL snapshot
  // taken at the top of this function — never a live re-read — so
  // "reappeared registration" is judged against exactly the status each
  // record had when this reconciliation pass began, the same discipline
  // the per-record loop above already applies to directory reappearance.
  const filesystem = scanOrphans(input, records);
  const registrations = await inspectGitRegistrations(input, records);

  return {
    worktreesScanned: records.length,
    interruptedCreationCount,
    artifactsRecovered,
    artifactsConfirmed,
    cleanupAttempts,
    worktreesCleaned,
    cleanupFailures,
    reconciliationBlockedCount,
    inconsistentCleanedDirectoryCount,
    inconsistentCleanedRegistrationCount: registrations.reappearedRegistrationWorktreeIds.size,
    orphanWorktreeDirectoryCount: filesystem.orphanCount,
    orphanWorktreeRegistrationCount: registrations.orphanRegistrationCount,
    registrationInspectionFailureCount:
      (filesystem.inspectionFailed ? 1 : 0) + registrations.inspectionFailureCount,
  };
}

function markInterruptedCreation(
  input: AgentWorktreeReconciliationInput,
  record: AgentWorktreeRecord,
): AgentWorktreeRecord {
  const now = input.now ?? (() => new Date().toISOString());
  const fresh = input.agentWorktreeStore.get(record.worktreeId);
  if (fresh.status !== "creating") return fresh;
  return input.agentWorktreeStore.markCreationFailed({
    worktreeId: fresh.worktreeId,
    expectedRevision: fresh.revision,
    safeFailureCode: RESTART_INTERRUPTED_WORKTREE_CREATION_CODE,
    safeFailureSummary:
      "Worktree creation was interrupted by a Hall Core restart and was not resumed.",
    now: now(),
  });
}

async function runCleanup(
  input: AgentWorktreeReconciliationInput,
  worktreeId: string,
): Promise<"cleaned" | "failed"> {
  try {
    const record = await input.agentWorktreeManager.cleanupWorktree(worktreeId);
    return record.status === "cleaned" ? "cleaned" : "failed";
  } catch (error) {
    console.error(
      `Recovery could not clean up agent worktree "${worktreeId}"; it remains recoverable on the next restart: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  }
}

type ReadyReconciliationOutcome = "artifact_recovered" | "artifact_confirmed" | "blocked";

async function reconcileReadyWorktree(
  input: AgentWorktreeReconciliationInput,
  record: AgentWorktreeRecord,
): Promise<ReadyReconciliationOutcome> {
  if (record.adapterId === undefined || record.agentId === undefined) {
    // A legacy row created before Phase 16.5's immutable-identity columns
    // existed. There is no safe way to know which adapter/agent owned this
    // run without guessing — retain the worktree, never fabricate.
    return "blocked";
  }

  const events = input.taskEventStore.list(record.hallTaskId);
  const terminalEvent = events.find(
    (event): event is NormalizedAgentEvent & { readonly type: TerminalEventType } =>
      event.runId === record.hallAgentRunId && isTerminalEventType(event.type),
  );
  if (terminalEvent === undefined) {
    // No terminal event exists yet for this exact run — genuinely still in
    // flight (should not happen after `reconcileTasks` has already run for
    // this boot, which synthesizes a terminal event for any mid-flight
    // run) or the run/worktree pairing cannot be proven terminal. Either
    // way, never invent one here.
    return "blocked";
  }
  if (terminalEvent.agentId !== record.agentId) {
    // The immutable identity captured at worktree creation disagrees with
    // the event stream's own agentId for this run — do not proceed.
    return "blocked";
  }

  const startedEvent = events.find(
    (event) => event.runId === record.hallAgentRunId && event.type === "run.started",
  );
  const snapshot: AgentExecutionTerminalSnapshot = {
    hallTaskId: record.hallTaskId,
    hallAgentRunId: record.hallAgentRunId,
    adapterId: record.adapterId,
    agentId: record.agentId,
    terminalEvent: {
      eventId: terminalEvent.eventId,
      sequence: terminalEvent.sequence,
      timestamp: terminalEvent.timestamp,
      type: terminalEvent.type,
    },
    startedAt: startedEvent?.timestamp ?? terminalEvent.timestamp,
    finishedAt: terminalEvent.timestamp,
    failure: terminalEvent.type === "run.failed" ? terminalEvent.payload.failure : undefined,
    cancellation:
      terminalEvent.type === "run.cancelled"
        ? {
            cancelledBy: terminalEvent.payload.cancelledBy,
            ...(terminalEvent.payload.reason !== undefined
              ? { reason: terminalEvent.payload.reason }
              : {}),
          }
        : undefined,
    finalSummary:
      terminalEvent.type === "run.completed" ? terminalEvent.payload.summary : undefined,
    exitCode: undefined,
    worktreeId: record.worktreeId,
  };

  const existedBefore =
    input.agentExecutionArtifactStore.findByHallAgentRunId(record.hallAgentRunId) !== undefined;
  try {
    await input.agentExecutionArtifactTerminalizer.terminalize({ snapshot });
  } catch (error) {
    console.error(
      `Recovery could not reconcile the execution artifact for agent worktree "${record.worktreeId}"; leaving the worktree untouched: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "blocked";
  }
  return existedBefore ? "artifact_confirmed" : "artifact_recovered";
}

function cleanedRecordLooksInconsistent(record: AgentWorktreeRecord): boolean {
  try {
    // A reappeared path is reported regardless of what it is (directory,
    // file, or symlink/junction) — this function only ever observes and
    // reports, it never deletes or inspects further. `lstatSync` throwing
    // (the ordinary, expected case for an already-cleaned worktree) means
    // nothing reappeared.
    fs.lstatSync(record.canonicalWorktreePath);
    return true;
  } catch {
    return false;
  }
}

interface FilesystemScanResult {
  readonly orphanCount: number;
  readonly inspectionFailed: boolean;
}

function knownCanonicalWorktreePaths(records: readonly AgentWorktreeRecord[]): ReadonlySet<string> {
  const known = new Set<string>();
  for (const record of records) {
    try {
      known.add(fs.realpathSync.native(record.canonicalWorktreePath));
    } catch {
      known.add(path.resolve(record.canonicalWorktreePath));
    }
  }
  return known;
}

/**
 * Read-only, count-only scan of the owned root's direct children for
 * entries not backed by any persisted worktree record — never deletes,
 * never prunes. A missing owned root (isolation configured but nothing
 * ever created there yet) is a legitimate zero; a root that exists but
 * could not be listed (permissions, an unreadable filesystem, etc.) is
 * reported as a bounded inspection failure instead — never silently
 * folded into the same zero. Symlink and junction entries are included in
 * the walk (never skipped purely because they are not an ordinary
 * directory) so an unexpected link under the owned root is still counted,
 * not silently ignored.
 */
function scanOrphans(
  input: AgentWorktreeReconciliationInput,
  records: readonly AgentWorktreeRecord[],
): FilesystemScanResult {
  const known = knownCanonicalWorktreePaths(records);

  if (!fs.existsSync(input.agentWorktreeRoot)) {
    return { orphanCount: 0, inspectionFailed: false };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(input.agentWorktreeRoot, { withFileTypes: true });
  } catch {
    return { orphanCount: 0, inspectionFailed: true };
  }

  let orphanCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (HALL_CONTROLLED_NON_WORKTREE_DIRECTORY_NAMES.has(entry.name)) continue;
    const candidatePath = path.join(input.agentWorktreeRoot, entry.name);
    let canonical: string;
    try {
      canonical = fs.realpathSync.native(candidatePath);
    } catch {
      // A broken symlink/junction is still reported as an orphan, never
      // silently skipped because it could not be resolved.
      orphanCount += 1;
      continue;
    }
    if (!known.has(canonical)) orphanCount += 1;
  }
  return { orphanCount, inspectionFailed: false };
}

interface GitRegistrationInspectionResult {
  readonly orphanRegistrationCount: number;
  readonly reappearedRegistrationWorktreeIds: ReadonlySet<string>;
  readonly inspectionFailureCount: number;
}

/**
 * Read-only, bounded inspection of Git's own worktree registrations,
 * through the existing `AgentWorktreeManager.listRegisteredWorktreePaths`
 * (which itself uses the bounded Git runner and fails closed on truncated
 * output) — never a second, ad hoc Git invocation. Processes each unique
 * persisted source repository exactly once, in deterministic (sorted)
 * order. Only registrations that resolve INSIDE the Hall-owned worktree
 * root are ever classified — the primary checkout, any comparison
 * worktree, and anything else Git happens to have registered elsewhere
 * are read but never touched, counted, or otherwise acted on by this
 * feature. Never deletes or prunes a registration under any
 * circumstance; a source repository whose registrations could not be
 * inspected (missing repository, malformed/truncated Git output, a Git
 * failure of any kind) contributes to a bounded failure count rather than
 * being silently treated as "no registrations."
 */
async function inspectGitRegistrations(
  input: AgentWorktreeReconciliationInput,
  records: readonly AgentWorktreeRecord[],
): Promise<GitRegistrationInspectionResult> {
  const bySourceRepo = new Map<string, AgentWorktreeRecord[]>();
  for (const record of records) {
    const forRepo = bySourceRepo.get(record.canonicalSourceRepositoryRoot) ?? [];
    forRepo.push(record);
    bySourceRepo.set(record.canonicalSourceRepositoryRoot, forRepo);
  }
  const sourceRepos = [...bySourceRepo.keys()].sort();

  let orphanRegistrationCount = 0;
  let inspectionFailureCount = 0;
  const reappeared = new Set<string>();

  for (const sourceRepo of sourceRepos) {
    const recordsForRepo = bySourceRepo.get(sourceRepo) ?? [];
    let registeredPaths: readonly string[];
    try {
      registeredPaths = await input.agentWorktreeManager.listRegisteredWorktreePaths(sourceRepo);
    } catch (error) {
      inspectionFailureCount += 1;
      console.error(
        `Recovery could not inspect Git worktree registrations for a source repository; reporting a bounded failure rather than assuming none exist: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const byCanonicalPath = new Map<string, AgentWorktreeRecord>();
    for (const record of recordsForRepo) {
      for (const canonical of [
        ...knownCanonicalWorktreePaths([record]),
        path.resolve(record.canonicalWorktreePath),
      ]) {
        byCanonicalPath.set(canonical, record);
      }
    }

    for (const registeredPath of registeredPaths) {
      // The primary checkout, a comparison worktree, or anything else Git
      // happens to know about that is not under Hall's own owned root is
      // out of scope for this feature entirely — never inspected further,
      // never classified, never touched.
      if (!isPathContained(input.agentWorktreeRoot, registeredPath)) continue;

      let canonicalRegistered: string;
      try {
        canonicalRegistered = fs.realpathSync.native(registeredPath);
      } catch {
        canonicalRegistered = registeredPath;
      }

      const owner = byCanonicalPath.get(canonicalRegistered) ?? byCanonicalPath.get(registeredPath);
      if (owner === undefined) {
        orphanRegistrationCount += 1;
        continue;
      }
      if (owner.status === "cleaned") {
        reappeared.add(owner.worktreeId);
      }
    }
  }

  return {
    orphanRegistrationCount,
    reappearedRegistrationWorktreeIds: reappeared,
    inspectionFailureCount,
  };
}
