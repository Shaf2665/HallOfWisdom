"use client";

import { useEffect, useId, useState } from "react";
import { getRoutingAnalysis } from "../../lib/api-client";
import type { RoutingCandidate, TaskRequirements } from "../../lib/api-schemas";

/**
 * Phase 14.1 — a single plan step's adapter-override control. Read-only
 * with respect to eligibility: it never decides whether an override is
 * allowed to persist — `CeoPlanOrchestrator.createVersion`'s server-side
 * validation (Task 2) is the real trust boundary. This selector only
 * displays the same eligibility analysis the "Find suitable agent" dialog
 * (`routing-dialog.tsx`) already shows for a whole task, scoped to one
 * step's own (possibly locally-edited, not-yet-saved) requirements —
 * never the parent task's stored requirements.
 */
export function CeoStepAdapterSelector({
  baseUrl,
  parentTaskId,
  requirements,
  selectedAdapterId,
  recommendedAdapterId,
  onChange,
}: {
  readonly baseUrl: string;
  readonly parentTaskId: string;
  readonly requirements: TaskRequirements | undefined;
  readonly selectedAdapterId: string | undefined;
  readonly recommendedAdapterId: string | undefined;
  readonly onChange: (selectedAdapterId: string | undefined) => void;
}) {
  const groupId = useId();
  const [candidates, setCandidates] = useState<readonly RoutingCandidate[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);

  const requiredCapabilitiesKey = requirements?.requiredCapabilities.join(",") ?? "";
  const allowedExecutionTrustKey = requirements?.allowedExecutionTrust.join(",") ?? "";

  useEffect(() => {
    // Nothing to fetch — the render below shows the "no requirements"
    // message directly from `requirements === undefined` instead, so any
    // stale `candidates`/`loadFailed` state is simply never rendered.
    if (requirements === undefined) return;
    const controller = new AbortController();
    getRoutingAnalysis(baseUrl, parentTaskId, requirements, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setCandidates(response.candidates);
        setLoadFailed(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoadFailed(true);
      });
    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the requirements' own values (requiredCapabilitiesKey/allowedExecutionTrustKey), not the fresh-every-render `requirements` object itself
  }, [baseUrl, parentTaskId, requiredCapabilitiesKey, allowedExecutionTrustKey]);

  if (requirements === undefined) {
    return (
      <p className="text-xs text-stone-500 dark:text-stone-400">
        This step does not have capability or execution-trust requirements set, so no adapter can be
        recommended or validated yet.
      </p>
    );
  }

  if (loadFailed) {
    return (
      <p role="alert" className="text-xs text-red-600 dark:text-red-400">
        Could not analyze candidates for this step.
      </p>
    );
  }

  const effectiveSelection = selectedAdapterId ?? recommendedAdapterId;

  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
        Agent
      </legend>
      {candidates.length === 0 ? (
        <p className="text-xs text-stone-500 dark:text-stone-400">Analyzing candidates…</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {candidates.map((candidate) => {
            const isTrustedLocal = candidate.executionTrust === "trusted_local";
            return (
              <label
                key={candidate.adapterId}
                className="flex items-start gap-2 text-xs text-stone-700 dark:text-stone-200"
              >
                <input
                  type="radio"
                  name={`${groupId}-adapter`}
                  aria-label={`${candidate.displayName} (${candidate.adapterId})`}
                  checked={effectiveSelection === candidate.adapterId}
                  disabled={!candidate.assignable}
                  onChange={() => {
                    onChange(
                      candidate.adapterId === recommendedAdapterId
                        ? undefined
                        : candidate.adapterId,
                    );
                  }}
                  className="mt-0.5"
                />
                <span className="flex flex-col gap-0.5">
                  <span>
                    {candidate.displayName} ({candidate.adapterId}) — {candidate.executionTrust}
                    {candidate.adapterId === recommendedAdapterId ? " · Recommended" : ""}
                  </span>
                  <span className="text-stone-500 dark:text-stone-400">{candidate.safeReason}</span>
                  {isTrustedLocal ? (
                    <span
                      role="alert"
                      className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                    >
                      Trusted-local: this agent runs with the Hall Core user&apos;s filesystem
                      permissions.
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
