"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiClientError,
  configureCeoPlanRunExecution,
  getCeoPlanRun,
  listCeoPlanRuns,
  startCeoPlanRun,
} from "../../lib/api-client";
import {
  DEFAULT_CEO_PLAN_EXECUTION_POLICY,
  type CeoDelegationLink,
  type CeoPlanRun,
  type CeoPlanStepExecution,
  type CeoPlanVersion,
} from "../../lib/api-schemas";
import { useCeoPlanRunEvents } from "../../hooks/use-ceo-plan-run-events";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STEP_ACTIVE_STATUSES = new Set(["claimed", "starting", "running", "retry_wait"]);
const STEP_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const AUTONOMOUS_CONFIRMATION_TEXT =
  "I authorize Hall to automatically start eligible child tasks under this execution policy.";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Hall couldn’t complete that action.";
}

type FriendlyStatus = "waiting" | "working" | "completed" | "failed" | "needs_attention";

const FRIENDLY_STATUS_LABELS: Record<FriendlyStatus, string> = {
  waiting: "Waiting",
  working: "Working",
  completed: "Completed",
  failed: "Failed",
  needs_attention: "Needs attention",
};

const FRIENDLY_STATUS_CLASSES: Record<FriendlyStatus, string> = {
  waiting: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  working: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  needs_attention: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

function friendlyRunStatus(status: CeoPlanRun["status"]): FriendlyStatus {
  switch (status) {
    case "running":
      return "working";
    case "paused":
    case "configured":
      return "waiting";
    case "awaiting_intervention":
    case "cancelled":
      return "needs_attention";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

function findCurrentStep(
  version: CeoPlanVersion,
  stepExecutions: readonly CeoPlanStepExecution[],
): { readonly title: string } | null {
  const stepsById = new Map(version.steps.map((s) => [s.id, s]));
  const ordered = [...stepExecutions].sort(
    (left, right) =>
      (stepsById.get(left.planStepId)?.position ?? 0) -
      (stepsById.get(right.planStepId)?.position ?? 0),
  );
  const next =
    ordered.find((step) => STEP_ACTIVE_STATUSES.has(step.status)) ??
    ordered.find((step) => step.status === "awaiting_intervention") ??
    ordered.find((step) => !STEP_TERMINAL_STATUSES.has(step.status));
  if (!next) return null;
  const planStep = stepsById.get(next.planStepId);
  return { title: planStep?.title ?? next.planStepId };
}

/**
 * Beginner-friendly counterpart to `CeoPlanExecutionSection` (the full
 * Phase 15 control surface on `/ceo/[planId]`): reuses the same run/step
 * data and the same default execution policy, but collapses configure+start
 * into one "Start work" action (autonomous mode, `DEFAULT_CEO_PLAN_EXECUTION_POLICY`
 * unchanged) and shows only overall progress, the current step, and a
 * five-word status. Every number knob and lifecycle control (pause, cancel,
 * emergency stop, per-step retry) stays on the full plan page — reachable
 * via "Review full plan" — never duplicated here.
 */
export function CeoGatewayExecutionPanel({
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
  const [state, setState] = useState<"loading" | "no-run" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [run, setRun] = useState<CeoPlanRun | null>(null);
  const [mutationToken, setMutationToken] = useState("");
  const [stepExecutions, setStepExecutions] = useState<readonly CeoPlanStepExecution[]>([]);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const refreshGenerationRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = (refreshGenerationRef.current += 1);
    const isStale = (): boolean => refreshGenerationRef.current !== generation;
    try {
      const { runs } = await listCeoPlanRuns(baseUrl);
      if (isStale()) return;
      const runsForPlan = runs.filter((r) => r.planId === planId);
      const active = runsForPlan.find((r) => !TERMINAL_RUN_STATUSES.has(r.status));
      const mostRecent = [...runsForPlan].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      )[0];
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
      setState("ready");
    } catch (error) {
      if (isStale()) return;
      setLoadError(safeMessage(error));
      setState("error");
    }
  }, [baseUrl, planId]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void refresh();
  }, [refresh]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const { events } = useCeoPlanRunEvents(
    run && !TERMINAL_RUN_STATUSES.has(run.status) ? run.id : null,
    wsBaseUrl,
  );
  const lastEventSequence = events[events.length - 1]?.sequence;
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (lastEventSequence === undefined) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEventSequence]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function handleStart(): Promise<void> {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    try {
      if (run?.status === "configured") {
        await startCeoPlanRun(baseUrl, run.id, mutationToken);
      } else {
        const configured = await configureCeoPlanRunExecution(baseUrl, planId, {
          executionMode: "autonomous",
          policy: DEFAULT_CEO_PLAN_EXECUTION_POLICY,
        });
        await startCeoPlanRun(baseUrl, configured.run.id, configured.mutationToken);
      }
      await refresh();
    } catch (error) {
      setStartError(safeMessage(error));
    } finally {
      setStarting(false);
    }
  }

  if (links.length === 0) return null;

  if (state === "loading") {
    return (
      <p role="status" className="text-sm text-stone-600 dark:text-stone-300">
        Checking work status…
      </p>
    );
  }

  if (state === "error") {
    return (
      <p role="alert" className="text-sm text-amber-800 dark:text-amber-300">
        {loadError}
      </p>
    );
  }

  const showStart = state === "no-run" || run?.status === "configured";

  if (showStart) {
    return (
      <div className="space-y-3">
        {startError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {startError}
          </p>
        ) : null}
        <label className="flex items-start gap-2 text-sm leading-5 text-stone-700 dark:text-stone-200">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => {
              setConfirmed(event.target.checked);
            }}
            className="mt-0.5"
          />
          <span>{AUTONOMOUS_CONFIRMATION_TEXT}</span>
        </label>
        <button
          type="button"
          disabled={starting || !confirmed}
          onClick={() => {
            void handleStart();
          }}
          className="rounded-lg bg-amber-700 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600 dark:hover:bg-amber-500"
        >
          {starting ? "Starting work…" : "Start work"}
        </button>
      </div>
    );
  }

  if (!run) return null;

  const totalSteps = version.steps.length;
  const completedSteps = stepExecutions.filter((step) => step.status === "completed").length;
  const friendly = friendlyRunStatus(run.status);
  const current = findCurrentStep(version, stepExecutions);

  return (
    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-100/60 p-3 dark:border-amber-800 dark:bg-amber-950/40">
      <div className="flex flex-wrap items-center gap-2">
        <h5 className="text-sm font-semibold">Work in progress</h5>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${FRIENDLY_STATUS_CLASSES[friendly]}`}
        >
          {FRIENDLY_STATUS_LABELS[friendly]}
        </span>
      </div>
      <p className="text-sm text-stone-700 dark:text-stone-200">
        {completedSteps} of {totalSteps} step{totalSteps === 1 ? "" : "s"} complete
      </p>
      {current ? (
        <p className="text-sm text-stone-700 dark:text-stone-200">
          Current step: {current.title}
        </p>
      ) : null}
    </div>
  );
}
