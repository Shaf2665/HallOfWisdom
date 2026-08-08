import path from "node:path";
import { randomUUID } from "node:crypto";
import { isContainedPath, validateWorkspace } from "@hall-of-wisdom/hall-runner";
import type { ResolvedServerConfig } from "../config/resolve-server-config.js";
import { DATABASE_BUSY_TIMEOUT_MS, DEFAULT_LIMITS, EXIT_INTERNAL_ERROR, EXIT_INVALID_INPUT } from "../config/server-config.js";
import { resolveDataDir } from "../persistence/database-config.js";
import { openDurableStorage } from "../persistence/durable-startup.js";
import { checkOrRecordConfigurationFingerprint } from "../persistence/server-metadata-repository.js";
import { InstanceOwnershipConflictError, PersistenceError } from "../persistence/persistence-errors.js";
import { canonicalizeHallOwnedRoot } from "../agent-worktrees/path-safety.js";
import { AgentWorktreePathError } from "../agent-worktrees/agent-worktree-errors.js";
import { createServerComposition } from "../composition/server-composition.js";

export const VERIFY_STORAGE_SKIPPED_LIVE_INSTANCE =
  "Hall Core is currently running against this data directory — storage and fingerprint checks were skipped (this is expected and safe).";

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * A side-effect-minimized configuration preflight — deliberately NOT
 * "normal startup minus `app.listen()`". Never calls `runRestartRecovery`
 * (no task/comparison/agent-worktree reconciliation, no CEO plan
 * recovery, no worktree cleanup) and never calls `app.listen()`. Reuses
 * `openDurableStorage()` exactly as real startup does — that function's
 * existing ownership-acquisition ordering (filesystem lock via
 * `acquireInstanceOwnership` before the database epoch bump via
 * `acquireDatabaseEpoch`) already fails closed with
 * `InstanceOwnershipConflictError` against a live-heartbeat owner *before*
 * ever bumping the epoch — so a live Hall Core instance is never fenced
 * out by a concurrent `--verify-only` run. That specific error is caught
 * here and treated as "skip storage checks," never as a preflight
 * failure. See docs/architecture/0017-persistent-hall-configuration.md.
 *
 * Every primitive this preflight calls (`validateWorkspace`,
 * `resolveDataDir`, `canonicalizeHallOwnedRoot`, `openDurableStorage`,
 * `checkOrRecordConfigurationFingerprint`, `createServerComposition`) is
 * synchronous today, so the actual work happens in the plain, synchronous
 * `runVerifyOnlySync` below; this wrapper's only job is presenting the
 * `Promise<number>` interface callers (and the test suite) rely on.
 */
export function runVerifyOnly(resolved: ResolvedServerConfig): Promise<number> {
  return Promise.resolve(runVerifyOnlySync(resolved));
}

function runVerifyOnlySync(resolved: ResolvedServerConfig): number {
  let workspaceRoot: string;
  try {
    workspaceRoot = validateWorkspace({
      workspaceRoot: resolved.workspaceRoot,
      workingDirectory: resolved.workspaceRoot,
    }).workspaceRoot;
  } catch (error) {
    console.error(formatError(error));
    return EXIT_INVALID_INPUT;
  }
  console.log(`OK: workspaceRoot is valid (${workspaceRoot}).`);

  let comparisonRoot: string | undefined;
  if (resolved.comparisonRoot !== undefined) {
    let canonicalComparisonRoot: string;
    try {
      canonicalComparisonRoot = validateWorkspace({
        workspaceRoot: resolved.comparisonRoot,
        workingDirectory: resolved.comparisonRoot,
      }).workspaceRoot;
    } catch (error) {
      console.error(formatError(error));
      return EXIT_INVALID_INPUT;
    }
    const caseSensitive = process.platform !== "win32" && process.platform !== "darwin";
    const nested =
      isContainedPath(workspaceRoot, canonicalComparisonRoot, { caseSensitive, path }) ||
      isContainedPath(canonicalComparisonRoot, workspaceRoot, { caseSensitive, path });
    if (nested) {
      console.error("comparisonRoot must not be nested inside, or an ancestor of, workspaceRoot.");
      return EXIT_INVALID_INPUT;
    }
    comparisonRoot = canonicalComparisonRoot;
    console.log(`OK: comparisonRoot is valid (${comparisonRoot}).`);
  }

  if (resolved.dataDir === undefined) {
    console.log("OK: ephemeral mode — no durable storage to verify.");
    return 0;
  }

  let canonicalDataDir: string;
  let agentWorktreeRoot: string | undefined;
  try {
    canonicalDataDir = resolveDataDir({ dataDir: resolved.dataDir, workspaceRoot, comparisonRoot });
    agentWorktreeRoot =
      resolved.agentWorktreeRoot === undefined
        ? undefined
        : canonicalizeHallOwnedRoot({
            rawOwnedRoot: resolved.agentWorktreeRoot,
            forbiddenRoots: [
              { canonicalPath: workspaceRoot, label: "workspace root" },
              { canonicalPath: canonicalDataDir, label: "data directory" },
              ...(comparisonRoot === undefined ? [] : [{ canonicalPath: comparisonRoot, label: "comparison root" }]),
            ],
          });
  } catch (error) {
    console.error(formatError(error));
    return error instanceof PersistenceError || error instanceof AgentWorktreePathError
      ? EXIT_INVALID_INPUT
      : EXIT_INTERNAL_ERROR;
  }
  console.log(`OK: dataDir is valid (${canonicalDataDir}).`);
  if (agentWorktreeRoot !== undefined) {
    console.log(`OK: agentWorktreeRoot is valid (${agentWorktreeRoot}).`);
  }

  const bootId = randomUUID();
  let opened;
  try {
    opened = openDurableStorage({ dataDir: canonicalDataDir, bootId, busyTimeoutMs: DATABASE_BUSY_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof InstanceOwnershipConflictError) {
      console.log(VERIFY_STORAGE_SKIPPED_LIVE_INSTANCE);
      return 0;
    }
    console.error(formatError(error));
    return error instanceof PersistenceError ? EXIT_INVALID_INPUT : EXIT_INTERNAL_ERROR;
  }

  const { db, ownershipHandle } = opened;
  try {
    // Deliberately NOT `runRestartRecovery()` — calling this repository
    // function directly is the whole point: no task/comparison/
    // agent-worktree reconciliation, no CEO plan recovery, no worktree
    // cleanup runs during a preflight.
    checkOrRecordConfigurationFingerprint(db, { workspaceRoot, comparisonRoot, agentWorktreeRoot });
    console.log("OK: configuration fingerprint check passed.");

    createServerComposition({
      workspaceRoot,
      mockScenario: resolved.mockScenario,
      mockStepDelayMs: resolved.mockStepDelayMs,
      limits: DEFAULT_LIMITS,
      enableCodexTrustedLocal: resolved.enableCodexTrustedLocal,
      comparisonRoot,
      agentWorktreeRoot,
      db,
    });
    console.log("OK: Hall Core composition succeeded.");
  } catch (error) {
    console.error(formatError(error));
    return error instanceof PersistenceError ? EXIT_INVALID_INPUT : EXIT_INTERNAL_ERROR;
  } finally {
    db.close();
    ownershipHandle.release();
  }

  console.log("OK: installation verified.");
  return 0;
}
