"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import {
  ApiClientError,
  cancelComparisonCandidate,
  deleteComparison,
  getComparison,
  prepareComparison,
  setComparisonPreference,
  startComparisonCandidate,
} from "../../lib/api-client";
import type { AgentComparisonRecord, ComparisonCandidateRecord } from "../../lib/api-schemas";
import { useComparisonCandidateEvents } from "../../hooks/use-comparison-candidate-events";
import { ConnectionStatus } from "../connection-status";
import { CandidateStatusBadge, ComparisonStatusBadge } from "./comparison-status-badge";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The action could not be completed.";
}

const TERMINAL_CANDIDATE_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Whether the comparison as a whole has nothing further in flight that
 * would make deleting its worktrees unsafe or premature: either
 * `prepareComparison` itself failed (nothing was ever started), the
 * comparison was cancelled, or every candidate has individually reached a
 * terminal status. Deliberately excludes `draft`/`preparing`/`running` —
 * worktrees are either not yet created or still in active use. Not
 * explicitly specified by the task description ("once candidates have
 * finished") — this is the judgment call implementing that phrase.
 */
function candidatesHaveFinished(comparison: AgentComparisonRecord): boolean {
  if (comparison.status === "failed" || comparison.status === "cancelled") return true;
  return comparison.candidates.every((c) => TERMINAL_CANDIDATE_STATUSES.has(c.status));
}

export function ComparisonDetail({
  baseUrl,
  wsBaseUrl,
  comparisonId,
}: {
  readonly baseUrl: string;
  readonly wsBaseUrl: string;
  readonly comparisonId: string;
}) {
  const [comparison, setComparison] = useState<AgentComparisonRecord | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const [prepareState, setPrepareState] = useState<"idle" | "pending">("idle");
  const [candidateBusy, setCandidateBusy] = useState<ReadonlySet<string>>(new Set());
  const [candidateErrors, setCandidateErrors] = useState<Record<string, string | null>>({});
  const [cleanupState, setCleanupState] = useState<"idle" | "pending">("idle");

  const [preferenceCandidateId, setPreferenceCandidateId] = useState("");
  const [preferenceNote, setPreferenceNote] = useState("");
  const [preferenceSubmitting, setPreferenceSubmitting] = useState(false);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const preferenceSeededRef = useRef(false);

  const refresh = useCallback(async (): Promise<AgentComparisonRecord | null> => {
    try {
      const record = await getComparison(baseUrl, comparisonId);
      setComparison(record);
      setState("ready");
      return record;
    } catch (error) {
      setLoadError(safeMessage(error));
      setState("error");
      return null;
    }
  }, [baseUrl, comparisonId]);

  // Fetches on mount — synchronizing with Hall Core, not deriving state
  // from props, so an effect (not render-time computation) is correct
  // here, mirroring app/page.tsx's `loadTasks` effect.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Seeds the preference form from the server's own record exactly once,
  // the first time it loads — never again on a later refresh, so an
  // operator's in-progress (unsaved) edits are never clobbered by a poll
  // or a terminal-event-triggered refetch.
  useEffect(() => {
    if (comparison && !preferenceSeededRef.current) {
      setPreferenceCandidateId(comparison.preference?.candidateId ?? "");
      setPreferenceNote(comparison.preference?.note ?? "");
      preferenceSeededRef.current = true;
    }
  }, [comparison]);

  /**
   * The WebSocket delivers a candidate's terminal event (`run.completed`/
   * `run.failed`/`run.cancelled`) as soon as it lands in the server's
   * event log — which is *before* `ComparisonOrchestrator#finalizeCandidate`
   * has necessarily finished capturing result evidence (real `git add`/
   * `git diff` calls against the candidate's worktree, genuinely taking a
   * few hundred milliseconds). A single `refresh()` right after the
   * terminal event can therefore race that finalization and return a
   * record whose candidate is still `"running"` — with no further WS
   * message ever coming to prompt another refetch, since the stream has
   * already closed. This polls with bounded backoff until the specific
   * candidate this stream was watching actually reaches a terminal
   * status, or the budget is exhausted (a final refresh either way keeps
   * the page from getting stuck showing stale "running" state).
   */
  const pollUntilCandidateTerminal = useCallback(
    async (candidateId: string): Promise<void> => {
      const delaysMs = [300, 600, 1200, 2000, 3000];
      for (const delayMs of delaysMs) {
        const record = await refresh();
        const candidate = record?.candidates.find((entry) => entry.candidateId === candidateId);
        if (candidate && TERMINAL_CANDIDATE_STATUSES.has(candidate.status)) return;
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      await refresh();
    },
    [refresh],
  );

  const runningCandidate = comparison?.candidates.find((c) => c.status === "running") ?? null;
  const { connectionState, events: liveEvents } = useComparisonCandidateEvents(
    comparison ? comparison.comparisonId : null,
    runningCandidate ? runningCandidate.candidateId : null,
    wsBaseUrl,
    {
      onTerminalEvent: () => {
        if (runningCandidate) {
          void pollUntilCandidateTerminal(runningCandidate.candidateId);
          return;
        }
        void refresh();
      },
    },
  );

  function isBusy(candidateId: string): boolean {
    return candidateBusy.has(candidateId);
  }

  async function withCandidateBusy(candidateId: string, run: () => Promise<void>): Promise<void> {
    setCandidateBusy((current) => new Set(current).add(candidateId));
    setCandidateErrors((current) => ({ ...current, [candidateId]: null }));
    try {
      await run();
    } finally {
      setCandidateBusy((current) => {
        const next = new Set(current);
        next.delete(candidateId);
        return next;
      });
    }
  }

  async function handlePrepare(): Promise<void> {
    setPrepareState("pending");
    try {
      const updated = await prepareComparison(baseUrl, comparisonId);
      setComparison(updated);
      setAnnouncement(
        updated.status === "ready"
          ? "Worktrees prepared. Candidates can now be started."
          : "Preparation failed — see the comparison status below.",
      );
    } catch (error) {
      setAnnouncement(safeMessage(error));
    } finally {
      setPrepareState("idle");
    }
  }

  async function handleStart(candidateId: string): Promise<void> {
    await withCandidateBusy(candidateId, async () => {
      try {
        const updated = await startComparisonCandidate(baseUrl, comparisonId, candidateId);
        setComparison(updated);
        setAnnouncement("Candidate started.");
      } catch (error) {
        // A 409 here means another candidate won the race to start first —
        // the backend enforces sequential-only execution; this is not a
        // bug, just a real concurrent-operator scenario to surface clearly.
        const message =
          error instanceof ApiClientError && error.code === "COMPARISON_STATE_CONFLICT"
            ? "Another candidate is already running. Only one candidate can run at a time — wait for it to finish, then try again."
            : safeMessage(error);
        setCandidateErrors((current) => ({ ...current, [candidateId]: message }));
        setAnnouncement(message);
        // Reconcile with the server's actual state after a conflict, since
        // this client's own view may now be stale.
        await refresh();
      }
    });
  }

  async function handleCancel(candidateId: string): Promise<void> {
    await withCandidateBusy(candidateId, async () => {
      try {
        await cancelComparisonCandidate(baseUrl, comparisonId, candidateId);
        setAnnouncement("Cancellation requested.");
      } catch (error) {
        setCandidateErrors((current) => ({ ...current, [candidateId]: safeMessage(error) }));
        setAnnouncement(safeMessage(error));
      } finally {
        await refresh();
      }
    });
  }

  async function handleCleanup(): Promise<void> {
    setCleanupState("pending");
    try {
      const updated = await deleteComparison(baseUrl, comparisonId);
      setComparison(updated);
      setAnnouncement(
        updated.cleanupStatus === "failed"
          ? "Cleanup failed. You can retry."
          : "Comparison cleaned up.",
      );
    } catch (error) {
      setAnnouncement(safeMessage(error));
    } finally {
      setCleanupState("idle");
    }
  }

  async function handlePreferenceSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (preferenceSubmitting) return;
    setPreferenceSubmitting(true);
    setPreferenceError(null);
    try {
      const trimmedNote = preferenceNote.trim();
      const updated = await setComparisonPreference(baseUrl, comparisonId, {
        candidateId: preferenceCandidateId === "" ? null : preferenceCandidateId,
        ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
      });
      setComparison(updated);
      setAnnouncement(
        preferenceCandidateId === ""
          ? "Preference cleared."
          : "Preference recorded. This is informational only — it does not merge, commit, or pick a winner.",
      );
    } catch (error) {
      setPreferenceError(safeMessage(error));
    } finally {
      setPreferenceSubmitting(false);
    }
  }

  if (state === "loading") {
    return (
      <p role="status" className="text-sm text-stone-500">
        Loading comparison…
      </p>
    );
  }

  if (state === "error" || !comparison) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {loadError}
      </p>
    );
  }

  const anyRunning = comparison.candidates.some((c) => c.status === "running");
  const showPrepare = comparison.status === "draft";
  const showCleanup =
    (candidatesHaveFinished(comparison) || comparison.cleanupStatus === "failed") &&
    comparison.status !== "cleaning" &&
    comparison.status !== "cleaned";

  return (
    <div className="flex flex-col gap-6">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold break-words">{comparison.title}</h2>
          <ComparisonStatusBadge status={comparison.status} />
        </div>
        {comparison.description ? (
          <p className="text-sm text-stone-700 dark:text-stone-300">{comparison.description}</p>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-500 dark:text-stone-400 sm:grid-cols-4">
          <div>
            <dt className="font-medium uppercase tracking-wide">Priority</dt>
            <dd className="capitalize">{comparison.priority}</dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide">Created</dt>
            <dd>{new Date(comparison.createdAt).toLocaleString()}</dd>
          </div>
          {comparison.baseCommit ? (
            <div>
              <dt className="font-medium uppercase tracking-wide">Base commit</dt>
              <dd className="break-all">{comparison.baseCommit.slice(0, 12)}</dd>
            </div>
          ) : null}
          <div>
            <dt className="font-medium uppercase tracking-wide">Cleanup</dt>
            <dd>{comparison.cleanupStatus.replace(/_/g, " ")}</dd>
          </div>
        </dl>
        {comparison.prepareFailureReason ? (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            Preparation failed: {comparison.prepareFailureReason}
          </p>
        ) : null}
        {comparison.cleanupError ? (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            Cleanup error: {comparison.cleanupError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {showPrepare ? (
            <button
              type="button"
              disabled={prepareState === "pending"}
              onClick={() => {
                void handlePrepare();
              }}
              className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
            >
              {prepareState === "pending" ? "Preparing…" : "Prepare"}
            </button>
          ) : null}
          {showCleanup ? (
            <button
              type="button"
              disabled={cleanupState === "pending"}
              onClick={() => {
                void handleCleanup();
              }}
              className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              {cleanupState === "pending"
                ? "Cleaning up…"
                : comparison.cleanupStatus === "failed"
                  ? "Retry clean up"
                  : "Clean up"}
            </button>
          ) : null}
        </div>
      </section>

      <section aria-label="Candidates" className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {comparison.candidates.map((candidate) => (
          <CandidatePanel
            key={candidate.candidateId}
            candidate={candidate}
            anyRunning={anyRunning}
            busy={isBusy(candidate.candidateId)}
            errorMessage={candidateErrors[candidate.candidateId] ?? null}
            isStreaming={runningCandidate?.candidateId === candidate.candidateId}
            connectionState={connectionState}
            liveEventCount={liveEvents.length}
            onStart={() => {
              void handleStart(candidate.candidateId);
            }}
            onCancel={() => {
              void handleCancel(candidate.candidateId);
            }}
          />
        ))}
      </section>

      <section className="flex flex-col gap-2 rounded border border-stone-200 p-3 dark:border-stone-800">
        <h3 className="text-sm font-semibold">Operator preference</h3>
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Informational only. Recording a preference here does not merge, commit, push, or otherwise
          act on either candidate&apos;s changes — it is just a note for whoever reviews this
          comparison later.
        </p>
        <form
          onSubmit={(event) => {
            void handlePreferenceSubmit(event);
          }}
          className="flex flex-col gap-2"
        >
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">Preferred candidate</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="preferred-candidate"
                value=""
                checked={preferenceCandidateId === ""}
                onChange={() => {
                  setPreferenceCandidateId("");
                }}
              />
              No preference
            </label>
            {comparison.candidates.map((candidate) => (
              <label key={candidate.candidateId} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="preferred-candidate"
                  value={candidate.candidateId}
                  checked={preferenceCandidateId === candidate.candidateId}
                  onChange={() => {
                    setPreferenceCandidateId(candidate.candidateId);
                  }}
                />
                {candidate.displayName} ({candidate.adapterId})
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-1">
            <label htmlFor="preference-note" className="text-sm font-medium">
              Note <span className="font-normal text-stone-500">(optional)</span>
            </label>
            <input
              id="preference-note"
              type="text"
              value={preferenceNote}
              onChange={(event) => {
                setPreferenceNote(event.target.value);
              }}
              maxLength={500}
              className="rounded border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-900"
            />
          </div>
          {preferenceError ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {preferenceError}
            </p>
          ) : null}
          <div>
            <button
              type="submit"
              disabled={preferenceSubmitting}
              className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              {preferenceSubmitting ? "Saving…" : "Save preference"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function CandidatePanel({
  candidate,
  anyRunning,
  busy,
  errorMessage,
  isStreaming,
  connectionState,
  liveEventCount,
  onStart,
  onCancel,
}: {
  readonly candidate: ComparisonCandidateRecord;
  readonly anyRunning: boolean;
  readonly busy: boolean;
  readonly errorMessage: string | null;
  readonly isStreaming: boolean;
  readonly connectionState: ReturnType<typeof useComparisonCandidateEvents>["connectionState"];
  readonly liveEventCount: number;
  readonly onStart: () => void;
  readonly onCancel: () => void;
}) {
  const canStart = candidate.status === "prepared" && !anyRunning;
  const canCancel =
    !candidate.cancellationRequested &&
    (candidate.status === "pending" ||
      candidate.status === "prepared" ||
      candidate.status === "running");
  const displayEventCount = isStreaming
    ? Math.max(candidate.eventCount, liveEventCount)
    : candidate.eventCount;

  return (
    <div className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3 text-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{candidate.displayName}</span>
        <CandidateStatusBadge status={candidate.status} />
      </div>
      <p className="text-xs text-stone-500 dark:text-stone-400">{candidate.adapterId}</p>

      {isStreaming ? <ConnectionStatus state={connectionState} /> : null}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-stone-600 dark:text-stone-300">
        {candidate.executionTrust ? (
          <div>
            <dt className="text-stone-400 dark:text-stone-500">Execution trust</dt>
            <dd>{candidate.executionTrust}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-stone-400 dark:text-stone-500">Events</dt>
          <dd>{displayEventCount}</dd>
        </div>
        {candidate.terminalEventType ? (
          <div>
            <dt className="text-stone-400 dark:text-stone-500">Terminal event</dt>
            <dd>{candidate.terminalEventType}</dd>
          </div>
        ) : null}
      </dl>

      {candidate.cancellationRequested ? (
        <p role="status" className="text-xs text-stone-600 dark:text-stone-300">
          Cancellation requested
        </p>
      ) : null}

      {candidate.safeFailureReason ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {candidate.safeFailureReason}
        </p>
      ) : null}
      {candidate.failure ? (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          <p className="font-medium">Failed — {candidate.failure.code}</p>
          <p>{candidate.failure.message}</p>
        </div>
      ) : null}

      {errorMessage ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {canStart ? (
          <button
            type="button"
            disabled={busy}
            onClick={onStart}
            className="rounded bg-amber-700 px-2 py-1 text-xs font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
          >
            {busy ? "Starting…" : "Start"}
          </button>
        ) : null}
        {canCancel ? (
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            {busy ? "Cancelling…" : "Cancel"}
          </button>
        ) : null}
      </div>

      {candidate.resultEvidence ? (
        <div className="flex flex-col gap-2 border-t border-stone-200 pt-2 dark:border-stone-800">
          <p className="text-xs text-stone-600 dark:text-stone-300">
            {candidate.resultEvidence.changedFiles.length} file
            {candidate.resultEvidence.changedFiles.length === 1 ? "" : "s"} changed, +
            {candidate.resultEvidence.totalAdditions} / -{candidate.resultEvidence.totalDeletions}
            {candidate.resultEvidence.truncated ? " (truncated)" : ""}
          </p>
          {candidate.resultEvidence.changedFiles.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-xs">
              {candidate.resultEvidence.changedFiles.map((file) => (
                <li key={file.relativePath} className="flex items-center justify-between gap-2">
                  <span className="truncate" title={file.relativePath}>
                    {file.relativePath}
                  </span>
                  <span className="shrink-0 text-stone-500 dark:text-stone-400">
                    {file.changeType} +{file.additions}/-{file.deletions}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {candidate.resultEvidence.boundedDiff ? (
            <details>
              <summary className="cursor-pointer text-xs font-medium text-stone-600 dark:text-stone-300">
                Show diff
              </summary>
              <pre className="mt-1 max-h-96 overflow-auto rounded bg-stone-50 p-2 text-xs dark:bg-stone-950">
                {candidate.resultEvidence.boundedDiff}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
