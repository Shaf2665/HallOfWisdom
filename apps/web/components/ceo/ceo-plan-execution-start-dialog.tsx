"use client";

import { useEffect, useId, useState } from "react";
import {
  ApiClientError,
  listAdapters,
  startCeoPlanRun,
  type RunMutationResponse,
} from "../../lib/api-client";
import type {
  AdapterSummary,
  CeoDelegationLink,
  CeoPlanRun,
  CeoPlanVersion,
} from "../../lib/api-schemas";
import { Dialog } from "../kanban/dialog";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The action could not be completed.";
}

const AUTONOMOUS_CONFIRMATION_TEXT =
  "I authorize Hall to automatically start eligible child tasks under this execution policy.";

const UNCLEAN_RESTART_STATEMENT =
  "If Hall Core restarts uncleanly while this run is active, execution pauses automatically for review — no interrupted work is retried automatically.";

const NO_AUTO_REPLAN_STATEMENT =
  "Hall performs no automatic replanning: it only executes the steps, dependencies, and adapters already approved in this plan version.";

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${String(seconds / 3600)}h`;
  if (seconds % 60 === 0) return `${String(seconds / 60)}m`;
  return `${String(seconds)}s`;
}

function stepLabel(version: CeoPlanVersion, stepId: string): string {
  const step = version.steps.find((s) => s.id === stepId);
  return step ? `Step ${String(step.position + 1)}: ${step.title}` : stepId;
}

/**
 * Starting a configured run is the one action that lets the scheduler
 * begin claiming signals for it. This dialog is deliberately the richest
 * confirmation surface in the execution feature — mirroring
 * `CeoApproveDialog`'s own "richest confirmation surface" precedent from
 * Phase 14 — because in `autonomous` mode this is the exact moment child
 * tasks can begin running without a further per-step click. Every field
 * shown here is read-only, server-computed data; nothing here is
 * browser-controlled. In `manual` mode the scheduler still evaluates
 * readiness but starts nothing on its own, so the same information is
 * shown but the confirmation checkbox is not required.
 */
export function CeoPlanExecutionStartDialog({
  baseUrl,
  run,
  version,
  links,
  mutationToken,
  onClose,
}: {
  readonly baseUrl: string;
  readonly run: CeoPlanRun;
  readonly version: CeoPlanVersion;
  readonly links: readonly CeoDelegationLink[];
  readonly mutationToken: string;
  readonly onClose: (result: RunMutationResponse | null) => void;
}) {
  const titleId = useId();
  const [adapters, setAdapters] = useState<readonly AdapterSummary[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requiresCheckbox = run.executionMode === "autonomous";
  const policy = run.policySnapshot;

  useEffect(() => {
    const controller = new AbortController();
    listAdapters(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAdapters(response.adapters);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  const adaptersById = new Map(adapters.map((a) => [a.adapterId, a]));
  const linksByStepId = new Map(links.map((link) => [link.stepId, link]));
  const dependencyCount = version.steps.reduce((sum, step) => sum + step.dependencies.length, 0);

  async function handleStart(): Promise<void> {
    if (submitting || (requiresCheckbox && !confirmed)) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await startCeoPlanRun(baseUrl, run.id, mutationToken);
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
      <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto">
        <h2 id={titleId} className="text-lg font-semibold">
          Start execution — plan version {version.version}
        </h2>
        {requiresCheckbox ? (
          <p className="text-sm text-stone-600 dark:text-stone-300">
            This run is configured for autonomous execution. Once started, Hall will start eligible
            child tasks on its own, in dependency order, within the limits below — no further
            per-step click is required.
          </p>
        ) : (
          <p className="text-sm text-stone-600 dark:text-stone-300">
            This run is configured for manual execution. Starting it lets the scheduler evaluate
            readiness, but no child task will start without a further explicit action per step.
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-600 dark:text-stone-300 sm:grid-cols-3">
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Approved plan version
            </dt>
            <dd>{version.version}</dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Child tasks
            </dt>
            <dd>{links.length}</dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Dependencies
            </dt>
            <dd>{dependencyCount === 0 ? "None — every step is independent" : dependencyCount}</dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Max concurrent steps
            </dt>
            <dd>{policy.maxConcurrentSteps}</dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Max attempts per step
            </dt>
            <dd>{policy.maxAttemptsPerStep}</dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Automatic transient retry
            </dt>
            <dd>
              {policy.allowAutomaticTransientRetry
                ? `On, ${formatDuration(policy.retryBackoffSeconds)} backoff`
                : "Off"}
            </dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Max step elapsed time
            </dt>
            <dd>{formatDuration(policy.maxStepElapsedSeconds)}</dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Max plan elapsed time
            </dt>
            <dd>{formatDuration(policy.maxPlanElapsedSeconds)}</dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
              Circuit breaker
            </dt>
            <dd>
              {policy.maxConsecutiveFailures} consecutive / {policy.maxNoProgressAttempts}{" "}
              no-progress
            </dd>
          </div>
        </dl>

        <div className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded border border-stone-200 p-2 dark:border-stone-800">
          {version.steps.map((step) => {
            const link = linksByStepId.get(step.id);
            const adapterId = link?.adapterId;
            const adapter = adapterId ? adaptersById.get(adapterId) : undefined;
            const isTrustedLocal = adapter?.executionTrust === "trusted_local";
            return (
              <div
                key={step.id}
                className="border-b border-stone-100 pb-2 text-sm last:border-b-0 dark:border-stone-900"
              >
                <p className="font-medium">
                  Step {step.position + 1}: {step.title}
                </p>
                <p className="text-xs text-stone-600 dark:text-stone-300">
                  Agent:{" "}
                  {adapterId
                    ? `${adapterId}${adapter ? ` (${adapter.executionTrust})` : ""}`
                    : "Unknown — not linked"}
                </p>
                {step.dependencies.length > 0 ? (
                  <p className="text-xs text-stone-500 dark:text-stone-400">
                    Depends on: {step.dependencies.map((d) => stepLabel(version, d)).join(", ")}
                  </p>
                ) : null}
                {isTrustedLocal ? (
                  <p
                    role="alert"
                    className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                  >
                    {adapter.limitationNotice ??
                      "Trusted-local: this agent runs with the Hall Core user's filesystem permissions."}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="text-xs text-stone-500 dark:text-stone-400">{UNCLEAN_RESTART_STATEMENT}</p>
        <p className="text-xs text-stone-500 dark:text-stone-400">{NO_AUTO_REPLAN_STATEMENT}</p>

        {requiresCheckbox ? (
          <label className="flex items-start gap-2 text-sm">
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
        ) : null}

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
            disabled={submitting || (requiresCheckbox && !confirmed)}
            title={
              requiresCheckbox && !confirmed
                ? "Check the authorization box above to enable this button."
                : undefined
            }
            onClick={() => {
              void handleStart();
            }}
            className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
          >
            {submitting ? "Starting…" : "Start execution"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
