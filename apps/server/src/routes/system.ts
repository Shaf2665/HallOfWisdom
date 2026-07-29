import type { FastifyInstance } from "fastify";
import { HIGHEST_KNOWN_SCHEMA_VERSION } from "../persistence/migrations.js";
import type { RecoverySummary } from "../recovery/restart-recovery.js";

export interface SystemStorageRouteDeps {
  readonly mode: "durable" | "in-memory";
  readonly startedAt: number;
  /** Present only when `mode === "durable"` — the summary `runRestartRecovery` produced at this boot. */
  readonly recovery?: RecoverySummary | undefined;
}

/**
 * `GET /api/v1/system/storage` — bounded, safe status fields only, mirroring
 * `health.ts`'s discipline: never a filesystem path, PID, raw error, or
 * anything from `boots.recovery_summary_json` beyond what `RecoverySummary`
 * itself already curated (see `classify-comparison-worktrees.ts`'s
 * `WorktreeClassification`, which deliberately has no path field either).
 * `recovery`/`previousShutdown`/`schemaVersion` are all `null` in ephemeral
 * mode — there is nothing durable to report.
 */
export function registerSystemStorageRoute(
  app: FastifyInstance,
  deps: SystemStorageRouteDeps,
): void {
  app.get("/api/v1/system/storage", () => {
    const recovery = deps.recovery;
    return {
      mode: deps.mode,
      ready: true,
      schemaVersion: deps.mode === "durable" ? HIGHEST_KNOWN_SCHEMA_VERSION : null,
      startedAt: new Date(deps.startedAt).toISOString(),
      previousShutdown: recovery?.previousShutdown ?? null,
      recovery:
        recovery !== undefined
          ? {
              tasksScanned: recovery.tasksScanned,
              taskEventProjectionsRepaired: recovery.taskEventProjectionsRepaired,
              taskTerminalOutcomesReplayed: recovery.taskTerminalOutcomesReplayed,
              interruptedTaskRunCount: recovery.interruptedTaskRunCount,
              comparisonsScanned: recovery.comparisonsScanned,
              interruptedPreparationCount: recovery.interruptedPreparationCount,
              interruptedCleanupCount: recovery.interruptedCleanupCount,
              comparisonEventProjectionsRepaired: recovery.comparisonEventProjectionsRepaired,
              comparisonTerminalOutcomesReplayed: recovery.comparisonTerminalOutcomesReplayed,
              interruptedCandidateRunCount: recovery.interruptedCandidateRunCount,
              worktreeHealthCounts: recovery.worktreeHealthCounts,
              orphanWorktreeCount: recovery.orphanWorktreeCount,
            }
          : null,
    };
  });
}
