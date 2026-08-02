"use client";

import { useEffect, useId, useState } from "react";
import type { SubmitEvent } from "react";
import { ApiClientError, assignTask, getRoutingAnalysis, listAdapters } from "../../lib/api-client";
import type { AdapterSummary, RoutingCandidate, TaskRecord } from "../../lib/api-schemas";
import { isAbsolutePathLike } from "../../lib/working-directory";
import { Dialog } from "./dialog";

/**
 * `RoutingCandidate` (the wire shape returned by `routing-analysis`)
 * carries the individual, already server-computed result fields
 * (`missingCapabilities`, `restrictedCapabilities`, `trustAllowed`) but
 * not a combined `eligible` boolean — this just ANDs those fields
 * together for display purposes; it does not re-derive capability
 * status or trust-allow-list membership itself, so it is not a second
 * compatibility algorithm, only a read of the server's own result.
 */
function isCandidateEligible(candidate: RoutingCandidate): boolean {
  return (
    candidate.missingCapabilities.length === 0 &&
    candidate.restrictedCapabilities.length === 0 &&
    candidate.trustAllowed
  );
}

export function AssignDialog({
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
  const [adapters, setAdapters] = useState<readonly AdapterSummary[]>([]);
  const [adaptersState, setAdaptersState] = useState<"loading" | "ready" | "error">("loading");
  const [adapterId, setAdapterId] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState("");
  const [workingDirectoryError, setWorkingDirectoryError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Phase 11.1 — only fetched when the task carries `requirements`; a
  // task with none behaves exactly as before this phase, no extra fetch.
  // This is a read-only hint for the UI (disable/explain incompatible
  // adapters) reusing the exact same `routing-analysis` endpoint and
  // eligibility evaluation the server itself uses — never a second,
  // client-side capability-matching algorithm. The server always
  // re-validates on submit regardless (`ADAPTER_REQUIREMENTS_MISMATCH`),
  // so a stale or failed fetch here can never let an incompatible
  // assignment through, only fail to warn about one in advance.
  const requirements = record.task.requirements;
  const [candidates, setCandidates] = useState<readonly RoutingCandidate[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listAdapters(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAdapters(response.adapters);
        setAdaptersState("ready");
        // No requirements: preserve the exact pre-11.1 behavior byte for
        // byte, including its timing — select the first available
        // adapter in the same state update as the adapter list itself,
        // rather than waiting on a second effect pass. A task with
        // requirements defers selection to the effect below, which also
        // needs the compatibility analysis before it can pick a genuinely
        // eligible adapter.
        if (requirements === undefined) {
          const firstAvailable = response.adapters.find((a) => a.availability === "available");
          if (firstAvailable) setAdapterId(firstAvailable.adapterId);
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setAdaptersState("error");
      });
    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `requirements` is read once here only to preserve legacy no-requirements timing; it does not need to re-trigger this fetch.
  }, [baseUrl]);

  useEffect(() => {
    if (requirements === undefined) return;
    const controller = new AbortController();
    getRoutingAnalysis(baseUrl, record.task.taskId, undefined, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setCandidates(response.candidates);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // Leave `candidates` null — every adapter simply shows without a
        // compatibility hint; the server-side check on submit is
        // unaffected either way.
      });
    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `requirements` is a fresh object identity every render (from `record.task`); keying on its own fields would be needed only if this dialog ever let the requirements change while open, which it doesn't.
  }, [baseUrl, record.task.taskId]);

  function candidateFor(id: string): RoutingCandidate | undefined {
    return candidates?.find((c) => c.adapterId === id);
  }

  function isDisabled(adapter: AdapterSummary): boolean {
    if (adapter.availability !== "available") return true;
    if (requirements === undefined) return false;
    const candidate = candidateFor(adapter.adapterId);
    // No candidate data yet (still loading, or fetch failed): never block
    // selection on missing client-side data — the server still validates.
    return candidate ? !isCandidateEligible(candidate) : false;
  }

  // Requirements case only — the no-requirements case is already handled
  // synchronously by the effect above, in the same state update as the
  // adapter list itself. This is a *derived* value, computed at render
  // time from state that's already settled, not synchronized via a
  // second effect + setState: once both the adapter list and the
  // compatibility analysis have arrived, it names the first adapter that
  // is both available and eligible — never a
  // merely-available-but-incompatible one. `adapterId` (the real state,
  // set only by the user's own `onChange`) always wins once the operator
  // has actually picked something.
  const autoSelectedAdapterId =
    requirements !== undefined && adaptersState === "ready" && candidates !== null
      ? adapters.find((a) => {
          if (a.availability !== "available") return false;
          const candidate = candidates.find((c) => c.adapterId === a.adapterId);
          return candidate !== undefined && isCandidateEligible(candidate);
        })?.adapterId
      : undefined;
  const effectiveAdapterId = adapterId !== "" ? adapterId : (autoSelectedAdapterId ?? "");

  const hasAvailableAdapter = adapters.some((a) => !isDisabled(a));

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    const trimmedDirectory = workingDirectory.trim();
    if (trimmedDirectory.length > 0) {
      if (trimmedDirectory.includes("\0")) {
        setWorkingDirectoryError("Working directory must not contain a NUL character.");
        return;
      }
      if (isAbsolutePathLike(trimmedDirectory)) {
        setWorkingDirectoryError("Working directory must be relative, not absolute.");
        return;
      }
    }
    setWorkingDirectoryError(null);

    if (effectiveAdapterId.trim().length === 0) {
      setSubmitError("Choose an agent to assign.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await assignTask(baseUrl, record.task.taskId, {
        adapterId: effectiveAdapterId,
        ...(trimmedDirectory.length > 0 ? { workingDirectory: trimmedDirectory } : {}),
      });
      onAssigned(updated);
    } catch (error) {
      setSubmitError(
        error instanceof ApiClientError ? error.message : "Assignment could not be completed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog titleId={titleId} onClose={onClose}>
      {/* Same `max-h-*` + `overflow-y-auto` defense as `RoutingDialog` — a task with `requirements` set adds a capability/trust summary block plus a selected-adapter eligibility notice, tall enough at 390×844 to be worth the same guard even though this dialog is less likely to overflow than the routing table. */}
      <form
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        noValidate
        className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          Assign an agent
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Assigning <span className="font-medium">{record.task.title}</span> does not start it — you
          will still need to click Start.
        </p>

        {requirements ? (
          <div className="rounded border border-stone-200 p-2 text-xs text-stone-600 dark:border-stone-800 dark:text-stone-300">
            <p>
              <span className="font-medium">Required capabilities:</span>{" "}
              {requirements.requiredCapabilities.length === 0
                ? "None"
                : requirements.requiredCapabilities.join(", ")}
            </p>
            <p>
              <span className="font-medium">Allowed execution trust:</span>{" "}
              {requirements.allowedExecutionTrust.join(", ")}
            </p>
            <p className="mt-1 text-stone-500 dark:text-stone-400">
              To choose an adapter outside this list, change this task&apos;s requirements first
              (Find suitable agent).
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <label htmlFor={`${titleId}-adapter`} className="text-sm font-medium">
            Agent
          </label>
          {adaptersState === "loading" ? (
            <p className="text-sm text-stone-500">Loading adapters…</p>
          ) : adaptersState === "error" ? (
            <p className="text-sm text-red-600 dark:text-red-400">Could not load adapters.</p>
          ) : (
            <select
              id={`${titleId}-adapter`}
              value={effectiveAdapterId}
              onChange={(event) => {
                setAdapterId(event.target.value);
              }}
              className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
            >
              <option value="" disabled>
                Select an agent…
              </option>
              {adapters.map((adapter) => {
                const disabled = isDisabled(adapter);
                const candidate = candidateFor(adapter.adapterId);
                const incompatibilityReason =
                  requirements &&
                  adapter.availability === "available" &&
                  candidate &&
                  !isCandidateEligible(candidate)
                    ? candidate.safeReason
                    : undefined;
                return (
                  <option
                    key={adapter.adapterId}
                    value={adapter.adapterId}
                    disabled={disabled}
                    title={incompatibilityReason ?? adapter.limitationNotice}
                  >
                    {adapter.agentDisplayName}
                    {adapter.availability !== "available" ? ` (${adapter.availability})` : ""}
                    {incompatibilityReason ? " (does not meet requirements)" : ""}
                    {adapter.limitationNotice ? " (see notice below)" : ""}
                  </option>
                );
              })}
            </select>
          )}
          {adaptersState === "ready" && !hasAvailableAdapter ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {requirements
                ? "No adapter currently satisfies this task's requirements."
                : "No adapter is currently available."}
            </p>
          ) : null}
          {(() => {
            const selected = adapters.find((a) => a.adapterId === effectiveAdapterId);
            const selectedCandidate = selected ? candidateFor(selected.adapterId) : undefined;
            return (
              <>
                {requirements &&
                selected?.availability === "available" &&
                selectedCandidate &&
                !isCandidateEligible(selectedCandidate) ? (
                  <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                    {selectedCandidate.safeReason}
                  </p>
                ) : null}
                {selected?.limitationNotice ? (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    {selected.limitationNotice}
                  </p>
                ) : null}
              </>
            );
          })()}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${titleId}-workdir`} className="text-sm font-medium">
            Working directory{" "}
            <span className="font-normal text-stone-500">(optional, relative)</span>
          </label>
          <input
            id={`${titleId}-workdir`}
            type="text"
            placeholder="."
            value={workingDirectory}
            onChange={(event) => {
              setWorkingDirectory(event.target.value);
            }}
            aria-invalid={workingDirectoryError ? true : undefined}
            aria-describedby={workingDirectoryError ? `${titleId}-workdir-error` : undefined}
            className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
          />
          {workingDirectoryError ? (
            <p
              id={`${titleId}-workdir-error`}
              role="alert"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {workingDirectoryError}
            </p>
          ) : null}
        </div>

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
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !hasAvailableAdapter}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
          >
            {submitting ? "Assigning…" : "Assign"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
