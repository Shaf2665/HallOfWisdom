"use client";

import { useId, useState, type ReactNode } from "react";
import {
  ApiClientError,
  configureCeoPlanRunExecution,
  type ConfigureCeoPlanRunResponse,
} from "../../lib/api-client";
import {
  DEFAULT_CEO_PLAN_EXECUTION_POLICY,
  MAX_CONSECUTIVE_FAILURES_CEILING,
  MAX_MAX_ATTEMPTS_PER_STEP,
  MAX_MAX_CONCURRENT_STEPS,
  MAX_NO_PROGRESS_ATTEMPTS_CEILING,
  MAX_PLAN_ELAPSED_SECONDS_CEILING,
  MAX_RETRY_BACKOFF_SECONDS,
  MAX_STEP_ELAPSED_SECONDS_CEILING,
  MIN_MAX_ATTEMPTS_PER_STEP,
  MIN_MAX_CONCURRENT_STEPS,
  type CeoPlanExecutionMode,
  type CeoPlanExecutionPolicy,
} from "../../lib/api-schemas";
import { Dialog } from "../kanban/dialog";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The action could not be completed.";
}

function numberField(
  label: string,
  value: number,
  min: number,
  max: number,
  onChange: (next: number) => void,
): ReactNode {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
        {label} ({min}–{max})
      </span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isInteger(next)) onChange(next);
        }}
        className="rounded border border-stone-300 px-2 py-1 dark:border-stone-700 dark:bg-stone-800"
      />
    </label>
  );
}

/**
 * Creates a Phase-15 execution run for an already-delegated plan. Per the
 * kickoff, configuring alone creates no task run — the operator must take
 * a separate, explicit "start execution" action
 * (`CeoPlanExecutionStartDialog`) before the scheduler claims anything.
 * `executionMode` defaults to `"manual"`, never `"autonomous"` — the
 * operator moves off that default deliberately, never by omission.
 */
export function CeoPlanExecutionConfigureDialog({
  baseUrl,
  planId,
  onClose,
}: {
  readonly baseUrl: string;
  readonly planId: string;
  readonly onClose: (result: ConfigureCeoPlanRunResponse | null) => void;
}) {
  const titleId = useId();
  const [executionMode, setExecutionMode] = useState<CeoPlanExecutionMode>("manual");
  const [policy, setPolicy] = useState<CeoPlanExecutionPolicy>(DEFAULT_CEO_PLAN_EXECUTION_POLICY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfigure(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await configureCeoPlanRunExecution(baseUrl, planId, {
        executionMode,
        policy,
      });
      onClose(result);
    } catch (err) {
      setError(safeMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      titleId={titleId}
      onClose={() => {
        onClose(null);
      }}
      maxWidthClassName="max-w-xl"
    >
      <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto">
        <h2 id={titleId} className="text-lg font-semibold">
          Configure execution
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Creates an execution run bound to this plan&apos;s delegated child tasks. This does not
          start anything — it only records the policy the scheduler will follow once you separately
          start execution.
        </p>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Execution mode
          </legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="executionMode"
              checked={executionMode === "manual"}
              onChange={() => {
                setExecutionMode("manual");
              }}
            />
            Manual — steps still require an operator to start each one individually
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="executionMode"
              checked={executionMode === "autonomous"}
              onChange={() => {
                setExecutionMode("autonomous");
              }}
            />
            Autonomous — the scheduler starts eligible steps on its own, under this policy
          </label>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          {numberField(
            "Max concurrent steps",
            policy.maxConcurrentSteps,
            MIN_MAX_CONCURRENT_STEPS,
            MAX_MAX_CONCURRENT_STEPS,
            (next) => {
              setPolicy((p) => ({ ...p, maxConcurrentSteps: next }));
            },
          )}
          {numberField(
            "Max attempts per step",
            policy.maxAttemptsPerStep,
            MIN_MAX_ATTEMPTS_PER_STEP,
            MAX_MAX_ATTEMPTS_PER_STEP,
            (next) => {
              setPolicy((p) => ({ ...p, maxAttemptsPerStep: next }));
            },
          )}
          {numberField(
            "Retry backoff (seconds)",
            policy.retryBackoffSeconds,
            0,
            MAX_RETRY_BACKOFF_SECONDS,
            (next) => {
              setPolicy((p) => ({ ...p, retryBackoffSeconds: next }));
            },
          )}
          {numberField(
            "Max plan elapsed (seconds)",
            policy.maxPlanElapsedSeconds,
            1,
            MAX_PLAN_ELAPSED_SECONDS_CEILING,
            (next) => {
              setPolicy((p) => ({ ...p, maxPlanElapsedSeconds: next }));
            },
          )}
          {numberField(
            "Max step elapsed (seconds)",
            policy.maxStepElapsedSeconds,
            1,
            MAX_STEP_ELAPSED_SECONDS_CEILING,
            (next) => {
              setPolicy((p) => ({ ...p, maxStepElapsedSeconds: next }));
            },
          )}
          {numberField(
            "Max consecutive failures",
            policy.maxConsecutiveFailures,
            1,
            MAX_CONSECUTIVE_FAILURES_CEILING,
            (next) => {
              setPolicy((p) => ({ ...p, maxConsecutiveFailures: next }));
            },
          )}
          {numberField(
            "Max no-progress attempts",
            policy.maxNoProgressAttempts,
            1,
            MAX_NO_PROGRESS_ATTEMPTS_CEILING,
            (next) => {
              setPolicy((p) => ({ ...p, maxNoProgressAttempts: next }));
            },
          )}
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={policy.allowAutomaticTransientRetry}
            onChange={(event) => {
              setPolicy((p) => ({ ...p, allowAutomaticTransientRetry: event.target.checked }));
            }}
            className="mt-0.5"
          />
          <span>Automatically retry transient (safe-to-retry) failures</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={policy.pauseOnAnyPermanentFailure}
            onChange={(event) => {
              setPolicy((p) => ({ ...p, pauseOnAnyPermanentFailure: event.target.checked }));
            }}
            className="mt-0.5"
          />
          <span>Pause the whole run for review on any permanent step failure</span>
        </label>

        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              onClose(null);
            }}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              void handleConfigure();
            }}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
          >
            {submitting ? "Configuring…" : "Configure"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
