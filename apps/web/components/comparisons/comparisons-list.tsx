"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiClientError, listComparisons } from "../../lib/api-client";
import type { AgentComparisonRecord } from "../../lib/api-schemas";
import { ComparisonStatusBadge } from "./comparison-status-badge";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Could not load comparisons.";
}

/**
 * Phase 12 — read-only list of every comparison Hall Core currently holds
 * in memory (comparisons are never persisted across a restart, per
 * `docs/architecture/0012-controlled-agent-comparison.md`). Comparisons
 * are created only from a Kanban card's "Compare agents" action
 * (`components/kanban/compare-agents-dialog.tsx`) — this page is
 * navigation/status only, never a creation form.
 */
export function ComparisonsList({ baseUrl }: { readonly baseUrl: string }) {
  const [comparisons, setComparisons] = useState<readonly AgentComparisonRecord[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listComparisons(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setComparisons(response.comparisons);
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
        Loading comparisons…
      </p>
    );
  }

  if (state === "error") {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {errorMessage}
      </p>
    );
  }

  if (comparisons.length === 0) {
    return (
      <p className="text-sm text-stone-500 dark:text-stone-400">
        No comparisons yet. Start one from a ready task&apos;s &quot;Compare agents&quot; action on
        the Kanban board.
      </p>
    );
  }

  const sorted = [...comparisons].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return (
    <div className="flex flex-col gap-4">
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-stone-200 dark:border-stone-800">
              <th scope="col" className="py-2 pr-3 font-medium">
                Task
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Status
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Candidates
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((comparison) => (
              <tr
                key={comparison.comparisonId}
                className="border-b border-stone-100 dark:border-stone-900"
              >
                <td className="py-2 pr-3 font-medium">
                  <Link
                    href={`/comparisons/${encodeURIComponent(comparison.comparisonId)}`}
                    className="underline decoration-stone-300 underline-offset-2 hover:decoration-stone-600 dark:decoration-stone-700 dark:hover:decoration-stone-400"
                  >
                    {comparison.title}
                  </Link>
                </td>
                <td className="py-2 pr-3">
                  <ComparisonStatusBadge status={comparison.status} />
                </td>
                <td className="py-2 pr-3 text-stone-600 dark:text-stone-300">
                  {comparison.candidates.map((c) => c.adapterId).join(" vs ")}
                </td>
                <td className="py-2 pr-3 text-stone-500 dark:text-stone-400">
                  {new Date(comparison.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 md:hidden">
        {sorted.map((comparison) => (
          <li
            key={comparison.comparisonId}
            className="flex flex-col gap-1 rounded border border-stone-200 bg-white p-3 text-sm shadow-sm dark:border-stone-800 dark:bg-stone-900"
          >
            <div className="flex items-center justify-between gap-2">
              <Link
                href={`/comparisons/${encodeURIComponent(comparison.comparisonId)}`}
                className="font-medium underline decoration-stone-300 underline-offset-2 hover:decoration-stone-600 dark:decoration-stone-700 dark:hover:decoration-stone-400"
              >
                {comparison.title}
              </Link>
              <ComparisonStatusBadge status={comparison.status} />
            </div>
            <p className="text-xs text-stone-600 dark:text-stone-300">
              {comparison.candidates.map((c) => c.adapterId).join(" vs ")}
            </p>
            <p className="text-xs text-stone-400 dark:text-stone-500">
              Created {new Date(comparison.createdAt).toLocaleString()}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
