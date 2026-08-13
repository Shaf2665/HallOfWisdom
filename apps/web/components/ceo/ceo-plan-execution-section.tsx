"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  ApiClientError,
  cancelCeoPlanRun,
  emergencyStopCeoPlanRun,
  getCeoPlanRun,
  getCeoPlanRunSchedulerStatus,
  listCeoPlanRuns,
  pauseCeoPlanRun,
  resumeCeoPlanRun,
  retryCeoPlanRunStep,
} from "../../lib/api-client";
import type {
  CeoDelegationLink,
  CeoPlanExecutionInterventionRecord,
  CeoPlanRun,
  CeoPlanRunSchedulerStatusResponse,
  CeoPlanStepAttempt,
  CeoPlanStepExecution,
  CeoPlanVersion,
  CircuitStateSnapshot,
} from "../../lib/api-schemas";
import { useCeoPlanRunEvents } from "../../hooks/use-ceo-plan-run-events";
import { ConnectionStatus } from "../connection-status";
import { CeoWorkerActivityPanel } from "./ceo-worker-activity-panel";
import { CeoPlanExecutionConfigureDialog } from "./ceo-plan-execution-configure-dialog";
import { CeoPlanExecutionStartDialog } from "./ceo-plan-execution-start-dialog";
import { CeoPlanExecutionConfirmDialog } from "./ceo-plan-execution-confirm-dialog";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The action could not be completed.";
}

const RUN_STATUS_LABELS: Record<string, string> = {
  configured: "Configured",
  running: "Running",
  paused: "Paused",
  awaiting_intervention: "Awaiting intervention",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const STEP_STATUS_LABELS: Record<string, string> = {
  waiting_for_dependencies: "Waiting on dependencies",
  ready: "Ready",
  queued: "Queued",
  claimed: "Claimed",
  starting: "Starting",
  running: "Running",
  retry_wait: "Waiting to retry",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  awaiting_intervention: "Awaiting intervention",
};

const RETRY_ELIGIBLE_STEP_STATUSES = new Set(["failed", "awaiting_intervention"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
/** Same set the scheduler's own `emergencyStop` uses to decide which steps have a linked active child task worth attempting cancellation on — see `ceo-plan-execution-scheduler.ts`. */
const ACTIVE_STEP_STATUSES = new Set(["claimed", "starting", "running"]);

const PAUSE_DESCRIPTION =
  "Pausing stops Hall from starting new child tasks. Tasks that are already running will continue.";
const CANCEL_DESCRIPTION =
  "Cancelling execution prevents Hall from scheduling any additional child tasks. Tasks that are already running will not be cancelled.";
const EMERGENCY_STOP_CONFIRMATION_TEXT =
  "I understand that Hall will attempt to cancel only the active tasks linked to this plan, and that some cancellations may fail.";

export function statusBadgeClass(status: string): string {
  if (status === "failed" || status === "cancelled") {
    return "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300";
  }
  if (status === "awaiting_intervention" || status === "retry_wait") {
    return "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300";
  }
  if (status === "completed") {
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300";
  }
  return "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300";
}

/**
 * Phase 15 — the browser-facing surface for autonomous plan execution,
 * shown on `/ceo/[planId]` once a plan reaches `delegated` status. Every
 * field displayed here comes only from the protocol package's public
 * execution shapes (`ceo-execution.ts`) or this file's own hand-mirrored
 * server response envelopes — internal revision counters, signal ids,
 * lease/owner-token data, epochs, DB paths, working directories, PIDs, raw
 * stderr, auth output, and hidden reasoning are never modeled in those
 * shapes at all, so this component cannot display them even by accident.
 */
export function CeoPlanExecutionSection({
  baseUrl,
  wsBaseUrl,
  planId,
  version,
  links,
}: {
  readonly baseUrl: string;
  readonly wsBaseUrl: string;
  readonly planId: string;
  readonly version: CeoPlanVersion;
  readonly links: readonly CeoDelegationLink[];
}) {
  const sectionTitleId = useId();
  const [state, setState] = useState<"loading" | "no-run" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [run, setRun] = useState<CeoPlanRun | null>(null);
  const [mutationToken, setMutationToken] = useState("");
  const [stepExecutions, setStepExecutions] = useState<readonly CeoPlanStepExecution[]>([]);
  const [attempts, setAttempts] = useState<readonly CeoPlanStepAttempt[]>([]);
  const [circuit, setCircuit] = useState<CircuitStateSnapshot | null>(null);
  const [interventions, setInterventions] = useState<readonly CeoPlanExecutionInterventionRecord[]>(
    [],
  );
  const [schedulerStatus, setSchedulerStatus] = useState<CeoPlanRunSchedulerStatusResponse | null>(
    null,
  );

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [showConfigure, setShowConfigure] = useState(false);
  const [showStart, setShowStart] = useState(false);
  const [showPauseConfirm, setShowPauseConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showEmergencyStopConfirm, setShowEmergencyStopConfirm] = useState(false);
  const [retryingStepId, setRetryingStepId] = useState<string | null>(null);

  const { connectionState, events } = useCeoPlanRunEvents(run?.id ?? null, wsBaseUrl);

  // Phase 15.3 — `refresh()` is triggered concurrently from up to five
  // independent call sites (mount, every distinct WS event sequence, and
  // each mutation handler below): nothing here ever guaranteed a LATER-
  // triggered call's response couldn't land before an EARLIER-triggered
  // one's, and an earlier response landing last would silently overwrite
  // newer state with stale state (e.g. clobbering "Attempts: 2" back down
  // to "Attempts: 1"), with nothing further re-triggering a refresh once
  // the WS event burst that would have corrected it subsides. A
  // monotonic generation counter — bump it before starting the fetch
  // chain, discard the result if a newer call has since started — makes
  // "this response is stale" cheap to detect without an AbortController
  // per fetch.
  const refreshGenerationRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = (refreshGenerationRef.current += 1);
    const isStale = (): boolean => refreshGenerationRef.current !== generation;
    try {
      const { runs } = await listCeoPlanRuns(baseUrl);
      if (isStale()) return;
      const runsForPlan = runs.filter((r) => r.planId === planId);
      const active = runsForPlan.find((r) => !TERMINAL_RUN_STATUSES.has(r.status));
      const mostRecent = [...runsForPlan].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const chosen = active ?? mostRecent;

      if (!chosen) {
        setRun(null);
        setState("no-run");
        return;
      }

      const detail = await getCeoPlanRun(baseUrl, chosen.id);
      if (isStale()) return;
      setRun(detail.run);
      setMutationToken(detail.mutationToken);
      setStepExecutions(detail.stepExecutions);
      setAttempts(detail.attempts);
      setCircuit(detail.circuit);
      setInterventions(detail.interventions);
      const status = await getCeoPlanRunSchedulerStatus(baseUrl, chosen.id);
      if (isStale()) return;
      setSchedulerStatus(status);
      setState("ready");
    } catch (error) {
      if (isStale()) return;
      setLoadError(safeMessage(error));
      setState("error");
    }
  }, [baseUrl, planId]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (links.length === 0) return;
    void refresh();
  }, [links.length, refresh]);

  const lastEventSequence = events[events.length - 1]?.sequence;
  useEffect(() => {
    if (lastEventSequence === undefined) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEventSequence]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Gated on whether this plan was ever delegated (`links` is populated
  // once, at delegation time, and never cleared), NOT on `planStatus`
  // still literally equalling `"delegated"` — a real bug found while
  // building this session's E2E specs: `plan.status` moves to a
  // different terminal value ("failed"/"completed"/...) once Phase 14's
  // own plan-progress reconciliation sees every delegated child task
  // reach a terminal status, which can happen while a Phase 15 execution
  // run is still legitimately `"running"`/`"paused"`/
  // `"awaiting_intervention"` (e.g. one step permanently failed under
  // `pauseOnAnyPermanentFailure: false` while sibling steps continue) —
  // gating on `planStatus` made the entire execution section, including
  // Pause/Cancel/Emergency-stop/Retry, silently vanish from the UI at
  // exactly the moment an operator would need it most.
  if (links.length === 0) return null;

  const stepsById = new Map(version.steps.map((s) => [s.id, s]));

  async function handleResume(): Promise<void> {
    if (!run || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await resumeCeoPlanRun(baseUrl, run.id, mutationToken);
      setAnnouncement("Execution resumed.");
      await refresh();
    } catch (error) {
      setActionError(safeMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleRetryStep(stepId: string): Promise<void> {
    if (!run || retryingStepId) return;
    setRetryingStepId(stepId);
    setActionError(null);
    try {
      await retryCeoPlanRunStep(baseUrl, run.id, stepId, mutationToken);
      setAnnouncement(`Retry requested for step ${stepId}.`);
      await refresh();
    } catch (error) {
      setActionError(safeMessage(error));
    } finally {
      setRetryingStepId(null);
    }
  }

  if (state === "loading") {
    return (
      <section aria-labelledby={sectionTitleId} className="flex flex-col gap-2">
        <h3 id={sectionTitleId} className="text-sm font-semibold">
          Autonomous execution
        </h3>
        <p role="status" className="text-sm text-stone-500">
          Loading execution status…
        </p>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section aria-labelledby={sectionTitleId} className="flex flex-col gap-2">
        <h3 id={sectionTitleId} className="text-sm font-semibold">
          Autonomous execution
        </h3>
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {loadError}
        </p>
      </section>
    );
  }

  if (state === "no-run" || !run) {
    return (
      <section aria-labelledby={sectionTitleId} className="flex flex-col gap-2">
        <h3 id={sectionTitleId} className="text-sm font-semibold">
          Autonomous execution
        </h3>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          This plan&apos;s delegated child tasks can be run under a scheduler policy instead of
          starting each one by hand. Configuring a run does not start anything.
        </p>
        <div>
          <button
            type="button"
            onClick={() => {
              setShowConfigure(true);
            }}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 dark:bg-amber-600"
          >
            Configure execution…
          </button>
        </div>
        {showConfigure ? (
          <CeoPlanExecutionConfigureDialog
            baseUrl={baseUrl}
            planId={planId}
            onClose={(result) => {
              setShowConfigure(false);
              if (result) {
                setAnnouncement("Execution run configured. It has not started.");
                void refresh();
              }
            }}
          />
        ) : null}
      </section>
    );
  }

  const showStartControl = run.status === "configured";
  const showPause = run.status === "running";
  const showResume = run.status === "paused" || run.status === "awaiting_intervention";
  const showCancelControl = !TERMINAL_RUN_STATUSES.has(run.status);
  const showEmergencyStopControl = !TERMINAL_RUN_STATUSES.has(run.status);
  const activeLinkedTaskCount = stepExecutions.filter((step) =>
    ACTIVE_STEP_STATUSES.has(step.status),
  ).length;

  return (
    <section aria-labelledby={sectionTitleId} className="flex flex-col gap-3">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={sectionTitleId} className="text-sm font-semibold">
          Autonomous execution
        </h3>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(run.status)}`}
        >
          {RUN_STATUS_LABELS[run.status] ?? run.status}
        </span>
        <span className="text-xs text-stone-500 dark:text-stone-400">
          {run.executionMode === "autonomous" ? "Autonomous mode" : "Manual mode"}
        </span>
      </div>
      <ConnectionStatus state={connectionState} />

      {actionError ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {actionError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {showStartControl ? (
          <button
            type="button"
            onClick={() => {
              setShowStart(true);
            }}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 dark:bg-amber-600"
          >
            Start execution…
          </button>
        ) : null}
        {showPause ? (
          <button
            type="button"
            onClick={() => {
              setShowPauseConfirm(true);
            }}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            Pause…
          </button>
        ) : null}
        {showResume ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void handleResume();
            }}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
          >
            {busy ? "Resuming…" : "Resume"}
          </button>
        ) : null}
        {showCancelControl ? (
          <button
            type="button"
            onClick={() => {
              setShowCancelConfirm(true);
            }}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            Cancel future scheduling…
          </button>
        ) : null}
        {showEmergencyStopControl ? (
          <button
            type="button"
            onClick={() => {
              setShowEmergencyStopConfirm(true);
            }}
            className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            Emergency stop…
          </button>
        ) : null}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-500 dark:text-stone-400 sm:grid-cols-4">
        <div>
          <dt className="font-medium uppercase tracking-wide">Max concurrent steps</dt>
          <dd>{run.policySnapshot.maxConcurrentSteps}</dd>
        </div>
        <div>
          <dt className="font-medium uppercase tracking-wide">Max attempts per step</dt>
          <dd>{run.policySnapshot.maxAttemptsPerStep}</dd>
        </div>
        <div>
          <dt className="font-medium uppercase tracking-wide">Automatic transient retry</dt>
          <dd>{run.policySnapshot.allowAutomaticTransientRetry ? "On" : "Off"}</dd>
        </div>
        <div>
          <dt className="font-medium uppercase tracking-wide">Pause on permanent failure</dt>
          <dd>{run.policySnapshot.pauseOnAnyPermanentFailure ? "Yes" : "No"}</dd>
        </div>
        {schedulerStatus ? (
          <>
            <div>
              <dt className="font-medium uppercase tracking-wide">Scheduler state</dt>
              <dd>{schedulerStatus.state}</dd>
            </div>
            <div>
              <dt className="font-medium uppercase tracking-wide">Running steps</dt>
              <dd>{schedulerStatus.runningStepCount}</dd>
            </div>
            <div>
              <dt className="font-medium uppercase tracking-wide">Waiting on dependencies</dt>
              <dd>{schedulerStatus.waitingForDependencyCount}</dd>
            </div>
            <div>
              <dt className="font-medium uppercase tracking-wide">Waiting to retry</dt>
              <dd>{schedulerStatus.retryWaitingCount}</dd>
            </div>
          </>
        ) : null}
        {circuit ? (
          <div>
            <dt className="font-medium uppercase tracking-wide">Circuit breaker</dt>
            <dd>
              {circuit.state === "open"
                ? `Open${circuit.tripReason ? ` (${circuit.tripReason})` : ""}`
                : "Closed"}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Steps ({stepExecutions.length})
        </h4>
        {stepExecutions.map((step) => {
          const planStep = stepsById.get(step.planStepId);
          const stepAttempts = attempts.filter((a) => a.planStepId === step.planStepId);
          const retryEligible = RETRY_ELIGIBLE_STEP_STATUSES.has(step.status);
          return (
            <div
              key={step.planStepId}
              className="flex flex-col gap-1 rounded border border-stone-200 p-3 text-sm dark:border-stone-800"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {planStep
                    ? `Step ${String(planStep.position + 1)}: ${planStep.title}`
                    : step.planStepId}
                </p>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(step.status)}`}
                >
                  {STEP_STATUS_LABELS[step.status] ?? step.status}
                </span>
              </div>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Attempts: {step.attemptCount}
                {stepAttempts.length > 0 ? ` (${String(stepAttempts.length)} recorded)` : ""} ·
                Dependencies: {step.dependencySummary.completedDependencies}/
                {step.dependencySummary.totalDependencies} completed
                {step.dependencySummary.failedDependencies > 0
                  ? `, ${String(step.dependencySummary.failedDependencies)} failed`
                  : ""}
              </p>
              {step.lastFailureCode ? (
                <p className="text-xs text-red-600 dark:text-red-400">
                  Last failure: {step.lastFailureCode}
                </p>
              ) : null}
              {step.nextEligibleAt ? (
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Eligible to retry at {new Date(step.nextEligibleAt).toLocaleString()}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Link
                  href="/board"
                  className="text-xs font-medium text-amber-700 hover:underline dark:text-amber-400"
                >
                  Open child task on board
                </Link>
                {retryEligible ? (
                  <button
                    type="button"
                    disabled={retryingStepId === step.planStepId}
                    onClick={() => {
                      void handleRetryStep(step.planStepId);
                    }}
                    className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
                  >
                    {retryingStepId === step.planStepId ? "Retrying…" : "Retry step"}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {interventions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Operator interventions
          </h4>
          <ul className="flex flex-col gap-1 text-xs text-stone-500 dark:text-stone-400">
            {interventions.map((intervention) => (
              <li key={intervention.id}>
                {new Date(intervention.createdAt).toLocaleString()} — {intervention.type}
                {intervention.note ? ` — "${intervention.note}"` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {events.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Execution activity
          </h4>
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-xs text-stone-500 dark:text-stone-400">
            {events.map((event) => (
              <li key={event.sequence}>
                {new Date(event.timestamp).toLocaleString()} — {event.type}
                {Object.keys(event.payload).length > 0
                  ? ` — ${Object.entries(event.payload)
                      .map(([key, value]) => `${key}: ${String(value)}`)
                      .join(", ")}`
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <CeoWorkerActivityPanel
        baseUrl={baseUrl}
        wsBaseUrl={wsBaseUrl}
        version={version}
        links={links}
        stepExecutions={stepExecutions}
        attempts={attempts}
      />

      {showStart ? (
        <CeoPlanExecutionStartDialog
          baseUrl={baseUrl}
          run={run}
          version={version}
          links={links}
          mutationToken={mutationToken}
          onClose={(result) => {
            setShowStart(false);
            if (result) {
              setAnnouncement("Execution started.");
              void refresh();
            }
          }}
        />
      ) : null}

      {showPauseConfirm ? (
        <CeoPlanExecutionConfirmDialog
          title="Pause execution?"
          description={PAUSE_DESCRIPTION}
          confirmLabel="Pause"
          busyLabel="Pausing…"
          onConfirm={async () => {
            await pauseCeoPlanRun(baseUrl, run.id, mutationToken);
          }}
          onDone={() => {
            setShowPauseConfirm(false);
            setAnnouncement("Execution paused.");
            void refresh();
          }}
          onClose={() => {
            setShowPauseConfirm(false);
          }}
        />
      ) : null}

      {showCancelConfirm ? (
        <CeoPlanExecutionConfirmDialog
          title="Cancel future scheduling?"
          description={CANCEL_DESCRIPTION}
          confirmLabel="Cancel future scheduling"
          busyLabel="Cancelling…"
          onConfirm={async () => {
            await cancelCeoPlanRun(baseUrl, run.id, mutationToken);
          }}
          onDone={() => {
            setShowCancelConfirm(false);
            setAnnouncement("Future scheduling cancelled for this run.");
            void refresh();
          }}
          onClose={() => {
            setShowCancelConfirm(false);
          }}
        />
      ) : null}

      {showEmergencyStopConfirm ? (
        <CeoPlanExecutionConfirmDialog
          title="Emergency stop?"
          description="Stops future scheduling first, then attempts to cancel only the child tasks currently active under this run."
          extra={
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-600 dark:text-stone-300">
              <div>
                <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
                  Active linked tasks
                </dt>
                <dd>{activeLinkedTaskCount}</dd>
              </div>
              <div className="col-span-2 flex flex-col gap-0.5">
                <p>Cancellation may be partial — some active tasks may not be cancellable.</p>
                <p>Tasks not linked to this plan run are never affected.</p>
              </div>
            </dl>
          }
          requiredCheckboxText={EMERGENCY_STOP_CONFIRMATION_TEXT}
          confirmLabel="Emergency stop"
          busyLabel="Stopping…"
          danger
          onConfirm={async () => {
            const result = await emergencyStopCeoPlanRun(baseUrl, run.id, mutationToken);
            const failedCount = result.result.outcomes.filter((o) => o.outcome === "failed").length;
            const total = result.result.outcomes.length;
            setAnnouncement(
              failedCount === 0
                ? `Emergency stop requested. ${String(total)} active task(s) cancellation-requested.`
                : `Emergency stop requested. ${String(total - failedCount)} of ${String(total)} active task(s) cancellation-requested; ${String(failedCount)} could not be cancelled.`,
            );
          }}
          onDone={() => {
            setShowEmergencyStopConfirm(false);
            void refresh();
          }}
          onClose={() => {
            setShowEmergencyStopConfirm(false);
          }}
        />
      ) : null}
    </section>
  );
}
