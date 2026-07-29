"use client";

import { useEffect, useState } from "react";
import { ApiClientError, getSystemStorage } from "../../lib/api-client";
import type { SystemStorageResponse } from "../../lib/api-schemas";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Could not load system status.";
}

const PREVIOUS_SHUTDOWN_LABEL: Record<string, string> = {
  clean: "Clean",
  unclean: "Unclean (interrupted)",
  first_start: "First startup",
};

const WORKTREE_HEALTH_LABEL: Record<string, string> = {
  healthy: "Healthy",
  interrupted: "Interrupted",
  workspace_missing: "Missing",
  workspace_unverified: "Unverified",
  cleanup_required: "Cleanup required",
  unsafe_path: "Unsafe path",
};

/**
 * Phase 13 — read-only durable-state status. Fetches `GET
 * /api/v1/system/storage` exactly like `AgentsCatalog` fetches
 * `/api/v1/adapters`: never mutates anything, renders only the bounded,
 * path-free fields the server sends (no filesystem path, PID, or raw error
 * ever reaches this component, because the server never sends one here).
 */
export function StorageStatus({ baseUrl }: { readonly baseUrl: string }) {
  const [storage, setStorage] = useState<SystemStorageResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getSystemStorage(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setStorage(response);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setErrorMessage(safeMessage(error));
        setState("error");
      });
    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  if (state === "loading") {
    return (
      <p role="status" className="text-sm text-stone-500">
        Loading system status…
      </p>
    );
  }
  if (state === "error" || storage === null) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {errorMessage}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Storage mode"
          value={storage.mode === "durable" ? "Durable" : "In-memory"}
        />
        <StatCard label="Schema version" value={storage.schemaVersion?.toString() ?? "—"} />
        <StatCard
          label="Previous shutdown"
          value={
            storage.previousShutdown !== null
              ? (PREVIOUS_SHUTDOWN_LABEL[storage.previousShutdown] ?? storage.previousShutdown)
              : "—"
          }
        />
        <StatCard label="Started" value={new Date(storage.startedAt).toLocaleString()} />
      </div>

      {storage.mode === "in-memory" ? (
        <div className="rounded border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700 dark:border-stone-800 dark:bg-stone-950/40 dark:text-stone-300">
          This server is running purely in memory. State does not survive a restart. Start it with
          <code className="mx-1 rounded bg-stone-200 px-1 py-0.5 dark:bg-stone-800">
            --data-dir
          </code>
          to enable durable, restart-surviving storage.
        </div>
      ) : (
        <RecoverySummarySection recovery={storage.recovery} />
      )}
    </div>
  );
}

function StatCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-900">
      <p className="text-xs font-medium text-stone-500 dark:text-stone-400">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function RecoverySummarySection({
  recovery,
}: {
  readonly recovery: SystemStorageResponse["recovery"];
}) {
  if (recovery === null) return null;

  const worktreeEntries = Object.entries(recovery.worktreeHealthCounts).filter(
    ([, count]) => count > 0,
  );

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-stone-700 dark:text-stone-300">
        Last restart recovery
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Tasks scanned" value={String(recovery.tasksScanned)} />
        <StatCard label="Interrupted task runs" value={String(recovery.interruptedTaskRunCount)} />
        <StatCard
          label="Task event projections repaired"
          value={String(recovery.taskEventProjectionsRepaired)}
        />
        <StatCard label="Comparisons scanned" value={String(recovery.comparisonsScanned)} />
        <StatCard
          label="Interrupted candidate runs"
          value={String(recovery.interruptedCandidateRunCount)}
        />
        <StatCard
          label="Interrupted preparations"
          value={String(recovery.interruptedPreparationCount)}
        />
        <StatCard label="Interrupted cleanups" value={String(recovery.interruptedCleanupCount)} />
        <StatCard label="Orphaned worktrees" value={String(recovery.orphanWorktreeCount)} />
      </div>

      {worktreeEntries.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {worktreeEntries.map(([health, count]) => (
            <span
              key={health}
              className="rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-700 dark:bg-stone-800 dark:text-stone-200"
            >
              {WORKTREE_HEALTH_LABEL[health] ?? health}: {count}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
