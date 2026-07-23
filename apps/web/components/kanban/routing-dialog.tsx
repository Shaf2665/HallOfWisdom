"use client";

import { useEffect, useId, useState } from "react";
import { ApiClientError, getRoutingAnalysis, routeAndAssign } from "../../lib/api-client";
import type {
  CapabilityId,
  ExecutionTrust,
  RoutingAnalysisResponse,
  TaskRecord,
  TaskRequirements,
} from "../../lib/api-schemas";
import { REQUIREMENT_PROFILES } from "../../lib/requirement-profiles";
import { Dialog } from "./dialog";

const ALL_CAPABILITIES: readonly CapabilityId[] = [
  "project.read",
  "project.edit",
  "command.execute",
  "git.inspect",
  "structured.events",
  "cancellation",
  "session.resume",
  "network.access",
];

const ALL_TRUST_LEVELS: readonly ExecutionTrust[] = [
  "isolated",
  "trusted_local",
  "simulated",
  "unavailable",
];

function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

/**
 * Phase 11 — read-only capability/trust routing analysis, plus the one
 * explicit, mutating "Route and assign" action. Mirrors `AssignDialog`'s
 * structure precisely (fetch-on-effect, shared `Dialog` wrapper,
 * explicit-confirm submit, `onClose` never mutates). Analysis re-runs
 * automatically whenever the chosen profile/custom selection changes —
 * still never a mutating call; only the explicit "Route and assign"
 * button ever calls `routeAndAssign()`.
 */
export function RoutingDialog({
  baseUrl,
  record,
  onAssigned,
  onClose,
}: {
  readonly baseUrl: string;
  readonly record: TaskRecord;
  readonly onAssigned: (updated: TaskRecord) => void;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const existingRequirements = record.task.requirements;
  const [profileId, setProfileId] = useState<string>(
    existingRequirements === undefined ? (REQUIREMENT_PROFILES[0]?.id ?? "custom") : "custom",
  );
  const [customCapabilities, setCustomCapabilities] = useState<CapabilityId[]>(
    existingRequirements?.requiredCapabilities ?? [],
  );
  const [customTrust, setCustomTrust] = useState<ExecutionTrust[]>(
    existingRequirements?.allowedExecutionTrust ?? ["isolated"],
  );

  const selectedProfile = REQUIREMENT_PROFILES.find((profile) => profile.id === profileId);
  const requirements: TaskRequirements =
    profileId === "custom" || selectedProfile?.requirements === undefined
      ? { requiredCapabilities: customCapabilities, allowedExecutionTrust: customTrust }
      : selectedProfile.requirements;
  const hasValidTrustSelection = requirements.allowedExecutionTrust.length > 0;
  // Deliberately keyed on the requirements' own values, not object identity
  // — `requirements` is a fresh object every render — so the effect below
  // only re-fetches when the actual selection changes.
  const requiredCapabilitiesKey = requirements.requiredCapabilities.join(",");
  const allowedExecutionTrustKey = requirements.allowedExecutionTrust.join(",");
  const requirementsKey = `${requiredCapabilitiesKey}|${allowedExecutionTrustKey}`;

  const [analysis, setAnalysis] = useState<RoutingAnalysisResponse | null>(null);
  const [analysisFailed, setAnalysisFailed] = useState(false);
  // The requirementsKey the current `analysis`/`analysisFailed` actually
  // corresponds to — never set synchronously in the effect below (only
  // from within its async callbacks, which the lint rule against
  // effect-body setState allows). "Still loading" is therefore a value
  // *derived* at render time (`resolvedKey !== requirementsKey`) rather
  // than tracked as its own piece of state.
  const [resolvedKey, setResolvedKey] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // No allowed trust level selected: nothing to fetch — the render below
    // shows a validation message directly from `hasValidTrustSelection`
    // rather than routing that case through fetch-lifecycle state.
    if (!hasValidTrustSelection) return;
    const controller = new AbortController();
    getRoutingAnalysis(baseUrl, record.task.taskId, requirements, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAnalysis(response);
        setAnalysisFailed(false);
        setResolvedKey(requirementsKey);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setAnalysisFailed(true);
        setResolvedKey(requirementsKey);
      });
    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on requirementsKey/hasValidTrustSelection (both derived from requiredCapabilitiesKey/allowedExecutionTrustKey below), not the fresh-every-render `requirements` object itself
  }, [baseUrl, record.task.taskId, requiredCapabilitiesKey, allowedExecutionTrustKey]);

  const isLoading = hasValidTrustSelection && resolvedKey !== requirementsKey;

  async function handleRouteAndAssign(): Promise<void> {
    if (submitting || analysis?.recommendedAdapterId === undefined) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await routeAndAssign(baseUrl, record.task.taskId, requirements);
      onAssigned(response.record);
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError ? error.message : "Routing could not be completed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog titleId={titleId} onClose={onClose} maxWidthClassName="max-w-2xl">
      <div className="flex flex-col gap-4">
        <h2 id={titleId} className="text-lg font-semibold">
          Find suitable agent
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Analyzing candidates for <span className="font-medium">{record.task.title}</span> never
          starts or assigns anything by itself — you must explicitly route and assign below.
        </p>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${titleId}-profile`} className="text-sm font-medium">
            Requirement profile
          </label>
          <select
            id={`${titleId}-profile`}
            value={profileId}
            onChange={(event) => {
              setProfileId(event.target.value);
            }}
            className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
          >
            {REQUIREMENT_PROFILES.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            {selectedProfile?.description}
          </p>
        </div>

        {profileId === "custom" ? (
          <div className="flex flex-col gap-3 rounded border border-stone-200 p-3 text-sm dark:border-stone-800">
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">Required capabilities</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {ALL_CAPABILITIES.map((capability) => (
                  <label key={capability} className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={customCapabilities.includes(capability)}
                      onChange={() => {
                        setCustomCapabilities((current) => toggled(current, capability));
                      }}
                    />
                    {capability}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="flex flex-col gap-1">
              <legend className="text-sm font-medium">Allowed execution trust</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {ALL_TRUST_LEVELS.map((trust) => (
                  <label key={trust} className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={customTrust.includes(trust)}
                      onChange={() => {
                        setCustomTrust((current) => toggled(current, trust));
                      }}
                    />
                    {trust}
                  </label>
                ))}
              </div>
              {customTrust.length === 0 ? (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                  Select at least one allowed execution trust level.
                </p>
              ) : null}
            </fieldset>
          </div>
        ) : null}

        {!hasValidTrustSelection ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            Select at least one allowed execution trust level.
          </p>
        ) : isLoading ? (
          <p className="text-sm text-stone-500">Analyzing candidates…</p>
        ) : analysisFailed ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            Could not analyze candidates.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-stone-200 dark:border-stone-800">
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Agent
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Trust
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Rank
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Reason
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {analysis?.candidates.map((candidate) => (
                    <tr
                      key={candidate.adapterId}
                      className={`border-b border-stone-100 dark:border-stone-900 ${
                        candidate.adapterId === analysis.recommendedAdapterId
                          ? "bg-amber-50 dark:bg-amber-950/30"
                          : ""
                      }`}
                    >
                      <td className="py-1 pr-2">{candidate.displayName}</td>
                      <td className="py-1 pr-2">{candidate.executionTrust}</td>
                      <td className="py-1 pr-2">{candidate.rank ?? "—"}</td>
                      <td className="py-1 text-stone-600 dark:text-stone-300">
                        {candidate.safeReason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p
              className={`text-sm ${
                analysis?.recommendedAdapterId === undefined
                  ? "text-red-600 dark:text-red-400"
                  : "text-stone-700 dark:text-stone-200"
              }`}
            >
              {analysis?.explanation}
            </p>
          </div>
        )}

        {submitError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {submitError}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            Close
          </button>
          <button
            type="button"
            disabled={
              submitting || !hasValidTrustSelection || analysis?.recommendedAdapterId === undefined
            }
            onClick={() => {
              void handleRouteAndAssign();
            }}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
          >
            {submitting ? "Assigning…" : "Route and assign"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
