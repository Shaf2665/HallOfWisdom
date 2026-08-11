"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ApiClientError,
  cancelCeoPlan,
  createCeoPlanVersion,
  deleteCeoPlan,
  getCeoPlan,
  getCeoPlanVersion,
  getTask,
  listCeoApprovals,
  submitCeoPlan,
} from "../../lib/api-client";
import type {
  CeoApproval,
  CeoDelegationLink,
  CeoPlan,
  CeoPlanProgressSummary,
  CeoPlanVersion,
} from "../../lib/api-schemas";
import { useCeoPlanEvents } from "../../hooks/use-ceo-plan-events";
import { ConnectionStatus } from "../connection-status";
import { Dialog } from "../kanban/dialog";
import { CeoPlanStatusBadge } from "./ceo-plan-status-badge";
import { CeoApproveDialog } from "./ceo-approve-dialog";
import { CeoRejectDialog } from "./ceo-reject-dialog";
import { CeoDelegateDialog } from "./ceo-delegate-dialog";
import { CeoPlanEditForm } from "./ceo-plan-edit-form";
import { CeoPlanExecutionSection } from "./ceo-plan-execution-section";
import { stepsWithAgentChoices, type AgentSelections } from "./ceo-plan-versioning";
import { useCeoStepAgentChoices } from "./use-ceo-step-agent-choices";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The action could not be completed.";
}

function hasAgentSelection(selections: AgentSelections, stepId: string): boolean {
  return Object.prototype.hasOwnProperty.call(selections, stepId);
}

const CANCELLABLE_STATUSES = new Set([
  "draft",
  "awaiting_approval",
  "approved",
  "rejected",
  "delegated",
]);

/** Matches `CeoPlanOrchestrator.createVersion`'s own allowed source statuses (Phase 14.1, Task 2) — kept in sync deliberately rather than inferred, since the server is the real trust boundary and this only controls whether the entry point is offered. */
const EDITABLE_STATUSES = new Set(["draft", "rejected", "awaiting_approval", "approved"]);

const STEP_PROGRESS_LABELS: Record<string, string> = {
  waiting_for_dependencies: "Waiting on dependencies",
  ready_to_start: "Ready to start",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked",
};

export function CeoPlanDetail({
  baseUrl,
  wsBaseUrl,
  planId,
}: {
  readonly baseUrl: string;
  readonly wsBaseUrl: string;
  readonly planId: string;
}) {
  const editFormTitleId = useId();
  const deleteDialogTitleId = useId();
  const router = useRouter();
  const [plan, setPlan] = useState<CeoPlan | null>(null);
  const [progress, setProgress] = useState<CeoPlanProgressSummary | null>(null);
  const [links, setLinks] = useState<readonly CeoDelegationLink[]>([]);
  const [mutationToken, setMutationToken] = useState("");
  const [activeVersion, setActiveVersion] = useState<CeoPlanVersion | null>(null);
  const [parentTaskTitle, setParentTaskTitle] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<readonly CeoApproval[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [showDelegate, setShowDelegate] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [agentSelections, setAgentSelections] = useState<{
    readonly version: number;
    readonly values: AgentSelections;
  }>({ version: 0, values: {} });

  const { connectionState, events } = useCeoPlanEvents(planId, wsBaseUrl);
  const { state: agentChoicesState, choices: agentChoices } = useCeoStepAgentChoices({
    baseUrl,
    parentTaskId: plan?.parentTaskId ?? "",
    steps: activeVersion?.steps ?? [],
  });

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [planResponse, approvalsResponse] = await Promise.all([
        getCeoPlan(baseUrl, planId),
        listCeoApprovals(baseUrl, planId),
      ]);
      setPlan(planResponse.plan);
      setProgress(planResponse.progress);
      setLinks(planResponse.links);
      setMutationToken(planResponse.mutationToken);
      setApprovals(approvalsResponse.approvals);
      const [version, taskTitle] = await Promise.all([
        getCeoPlanVersion(baseUrl, planId, planResponse.plan.activeVersion),
        getTask(baseUrl, planResponse.plan.parentTaskId)
          .then((taskRecord) => taskRecord.task.title)
          .catch(() => planResponse.plan.parentTaskId),
      ]);
      setActiveVersion(version);
      setParentTaskTitle(taskTitle);
      setState("ready");
    } catch (error) {
      setLoadError(safeMessage(error));
      setState("error");
    }
  }, [baseUrl, planId]);

  // `refresh` only ever calls setState after an `await` (never
  // synchronously within the effect body itself) — the same shape as
  // `comparison-detail.tsx`'s own mount effect. Disabled here (rather
  // than left to the rule) because calling `refresh` from two separate
  // effects below makes the plugin's cross-effect escape analysis
  // over-flag both as synchronous, mirroring the same suppression
  // `hooks/use-comparison-candidate-events.ts` already applies for its
  // own reset-on-identity-change effect.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A new plan event (e.g. another operator's decision, or this plan's
  // own progress advancing as child tasks run) means this page's snapshot
  // may be stale — re-fetch rather than trust the event payload itself,
  // which is a bounded audit summary, not the source of truth.
  const lastEventSequence = events[events.length - 1]?.sequence;
  useEffect(() => {
    if (lastEventSequence === undefined) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEventSequence]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function handleSubmit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await submitCeoPlan(baseUrl, planId, mutationToken);
      setAnnouncement("Plan submitted for approval.");
      await refresh();
    } catch (error) {
      setActionError(safeMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await cancelCeoPlan(baseUrl, planId, mutationToken);
      setAnnouncement("Plan cancelled.");
      await refresh();
    } catch (error) {
      setActionError(safeMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (busy || plan?.status !== "cancelled") return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteCeoPlan(baseUrl, planId, mutationToken);
      router.push("/ceo");
    } catch (error) {
      setActionError(safeMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") {
    return (
      <p role="status" className="text-sm text-stone-500">
        Loading plan…
      </p>
    );
  }

  if (state === "error" || !plan || !activeVersion || !progress) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {loadError}
      </p>
    );
  }

  // Only a `draft` plan may be submitted — a `rejected`/`awaiting_approval`/
  // `approved` plan's forward path back to `draft` is the edit form below
  // (`createVersion`, Phase 14.1), never a direct re-submit; offering
  // "Submit for approval" on one of those would 409.
  const showSubmit = plan.status === "draft";
  const showApproveReject = plan.status === "awaiting_approval";
  const showDelegateAction = plan.status === "approved";
  const showCancel = CANCELLABLE_STATUSES.has(plan.status);
  const showDeleteAction = plan.status === "cancelled";
  const showEdit = EDITABLE_STATUSES.has(plan.status);
  const currentVersion = activeVersion;
  const progressByStepId = new Map(progress.steps.map((s) => [s.stepId, s.status]));
  const activeAgentSelections =
    agentSelections.version === currentVersion.version ? agentSelections.values : {};
  const hasAgentChoiceChanges = currentVersion.steps.some(
    (step) =>
      hasAgentSelection(activeAgentSelections, step.id) &&
      activeAgentSelections[step.id] !== step.selectedAdapterId,
  );

  function chooseAgent(
    stepId: string,
    selectedAdapterId: string,
    recommendedAdapterId: string | undefined,
    currentSelectedAdapterId: string | undefined,
  ): void {
    const nextSelectedAdapterId =
      selectedAdapterId === recommendedAdapterId ? undefined : selectedAdapterId;
    setAgentSelections((current) => {
      const values = current.version === currentVersion.version ? current.values : {};
      if (nextSelectedAdapterId === currentSelectedAdapterId) {
        const { [stepId]: _discarded, ...unchanged } = values;
        return { version: currentVersion.version, values: unchanged };
      }
      return {
        version: currentVersion.version,
        values: { ...values, [stepId]: nextSelectedAdapterId },
      };
    });
  }

  async function saveAgentChoices(): Promise<void> {
    if (busy || !hasAgentChoiceChanges) return;
    setBusy(true);
    setActionError(null);
    try {
      const created = await createCeoPlanVersion(baseUrl, planId, {
        expectedMutationToken: mutationToken,
        objective: currentVersion.objective,
        summary: currentVersion.summary,
        assumptions: currentVersion.assumptions,
        constraints: currentVersion.constraints,
        steps: stepsWithAgentChoices(currentVersion, activeAgentSelections),
      });
      setAgentSelections({ version: created.version.version, values: {} });
      setAnnouncement("New plan version saved with updated agent choices.");
      await refresh();
    } catch (error) {
      setActionError(safeMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">
            CEO Plan — {parentTaskTitle ?? plan.parentTaskId}
          </h2>
          <CeoPlanStatusBadge status={plan.status} />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-stone-500 dark:text-stone-400 sm:grid-cols-4">
          <div>
            <dt className="font-medium uppercase tracking-wide">Active version</dt>
            <dd>{plan.activeVersion}</dd>
          </div>
          <div>
            <dt className="font-medium uppercase tracking-wide">Created</dt>
            <dd>{new Date(plan.createdAt).toLocaleString()}</dd>
          </div>
          {plan.delegatedAt ? (
            <div>
              <dt className="font-medium uppercase tracking-wide">Delegated</dt>
              <dd>{new Date(plan.delegatedAt).toLocaleString()}</dd>
            </div>
          ) : null}
          {plan.completedAt ? (
            <div>
              <dt className="font-medium uppercase tracking-wide">Completed</dt>
              <dd>{new Date(plan.completedAt).toLocaleString()}</dd>
            </div>
          ) : null}
        </dl>
        <ConnectionStatus state={connectionState} />

        {actionError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {actionError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {showSubmit ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void handleSubmit();
              }}
              className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
            >
              {busy ? "Submitting…" : "Submit for approval"}
            </button>
          ) : null}
          {showApproveReject ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setShowApprove(true);
                }}
                className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 dark:bg-emerald-600"
              >
                Approve…
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowReject(true);
                }}
                className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                Reject…
              </button>
            </>
          ) : null}
          {showDelegateAction ? (
            <button
              type="button"
              onClick={() => {
                setShowDelegate(true);
              }}
              className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 dark:bg-amber-600"
            >
              Delegate…
            </button>
          ) : null}
          {showCancel ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void handleCancel();
              }}
              className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              {busy ? "Cancelling…" : "Cancel plan"}
            </button>
          ) : null}
          {showEdit ? (
            <button
              type="button"
              onClick={() => {
                setShowEditForm(true);
              }}
              className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              Edit plan…
            </button>
          ) : null}
          {showDeleteAction ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setShowDelete(true);
              }}
              className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              Delete plan
            </button>
          ) : null}
        </div>
        {plan.status === "delegated" && links.length > 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            This plan already has {links.length} linked child task{links.length === 1 ? "" : "s"}.
            Cancelling the plan tracking does not cancel or stop them — manage those individually on
            the Kanban board.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Objective</h3>
        <p className="text-sm text-stone-700 dark:text-stone-300">{activeVersion.objective}</p>
        <p className="text-sm text-stone-700 dark:text-stone-300">{activeVersion.summary}</p>
        {activeVersion.assumptions.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Assumptions
            </h4>
            <ul className="list-disc pl-5 text-sm text-stone-600 dark:text-stone-300">
              {activeVersion.assumptions.map((assumption, index) => (
                <li key={index}>{assumption}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {activeVersion.constraints.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Constraints
            </h4>
            <ul className="list-disc pl-5 text-sm text-stone-600 dark:text-stone-300">
              {activeVersion.constraints.map((constraint, index) => (
                <li key={index}>{constraint}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-label="Plan steps" className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Steps ({activeVersion.steps.length})</h3>
        {activeVersion.steps.map((step) => {
          const stepProgress = progressByStepId.get(step.id);
          const stepChoices = agentChoices[step.id] ?? [];
          const selectedAdapterId = hasAgentSelection(activeAgentSelections, step.id)
            ? activeAgentSelections[step.id]
            : step.selectedAdapterId;
          const adapterId = selectedAdapterId ?? step.recommendedAdapterId;
          const matchingChoice = stepChoices.find((choice) => choice.id === adapterId);
          const effectiveSelection = selectedAdapterId ?? step.recommendedAdapterId;
          const selectValue = stepChoices.some((choice) => choice.id === effectiveSelection)
            ? effectiveSelection
            : "";
          return (
            <div
              key={step.id}
              className="flex flex-col gap-1 rounded border border-stone-200 p-3 text-sm dark:border-stone-800"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  Step {step.position + 1}: {step.title}
                </p>
                {stepProgress ? (
                  <span className="rounded-full bg-stone-200 px-2 py-0.5 text-xs font-medium text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                    {STEP_PROGRESS_LABELS[stepProgress] ?? stepProgress}
                  </span>
                ) : null}
              </div>
              <p className="text-stone-700 dark:text-stone-300">{step.objective}</p>
              <p className="text-xs text-stone-500 dark:text-stone-400">{step.routingSummary}</p>
              {adapterId ? (
                <p className="text-xs text-stone-600 dark:text-stone-300">
                  {selectedAdapterId ? "Selected agent" : "Recommended agent"}:{" "}
                  {matchingChoice ? `${matchingChoice.name} (${matchingChoice.id})` : adapterId}
                </p>
              ) : (
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  No agent selected or recommended.
                </p>
              )}
              {showEdit ? (
                <div className="mt-1 flex flex-col gap-1">
                  <label className="flex flex-wrap items-center gap-2 text-xs font-medium text-stone-700 dark:text-stone-200">
                    Agent
                    {agentChoicesState === "loading" ? (
                      <span className="font-normal text-stone-500 dark:text-stone-400">
                        Finding available agents…
                      </span>
                    ) : null}
                    {agentChoicesState === "error" ? (
                      <span className="font-normal text-red-600 dark:text-red-400">
                        Could not load available agents.
                      </span>
                    ) : null}
                    {agentChoicesState === "ready" && stepChoices.length === 0 ? (
                      <span className="font-normal text-stone-500 dark:text-stone-400">
                        No available agent for this step.
                      </span>
                    ) : null}
                    {agentChoicesState === "ready" && stepChoices.length > 0 ? (
                      <select
                        aria-label={`Agent for ${step.title}`}
                        value={selectValue}
                        disabled={busy}
                        onChange={(event) => {
                          chooseAgent(
                            step.id,
                            event.target.value,
                            step.recommendedAdapterId,
                            step.selectedAdapterId,
                          );
                        }}
                        className="rounded border border-stone-300 bg-white px-2 py-1 text-xs dark:border-stone-700 dark:bg-stone-900"
                      >
                        <option value="" disabled>
                          Choose an agent
                        </option>
                        {stepChoices.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.name} ({choice.id})
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </label>
                </div>
              ) : null}
              {step.dependencies.length > 0 ? (
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Depends on {step.dependencies.length} earlier step
                  {step.dependencies.length === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
          );
        })}
        {showEdit ? (
          <div className="flex flex-wrap items-center gap-3 rounded border border-stone-200 p-3 dark:border-stone-800">
            <p className="text-xs text-stone-600 dark:text-stone-300">
              Saving creates a new plan version; it does not start any work.
            </p>
            <button
              type="button"
              disabled={busy || !hasAgentChoiceChanges}
              onClick={() => {
                void saveAgentChoices();
              }}
              className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              {busy ? "Saving agent choices…" : "Save agent choices"}
            </button>
          </div>
        ) : null}
      </section>

      {approvals.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Approval history</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {approvals.map((approval, index) => (
              <li key={index} className="text-stone-600 dark:text-stone-300">
                Version {approval.planVersion} — {approval.decision} at{" "}
                {new Date(approval.decidedAt).toLocaleString()}
                {approval.operatorNote ? ` — "${approval.operatorNote}"` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {links.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Delegated child tasks</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {links.map((link) => (
              <li key={link.stepId} className="text-stone-600 dark:text-stone-300">
                Step {link.stepId} → task {link.childTaskId} ({link.adapterId})
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <CeoPlanExecutionSection
        baseUrl={baseUrl}
        wsBaseUrl={wsBaseUrl}
        planId={planId}
        version={activeVersion}
        links={links}
      />

      {events.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Activity</h3>
          <ul className="flex flex-col gap-1 text-xs text-stone-500 dark:text-stone-400">
            {events.map((event) => (
              <li key={event.sequence}>
                {new Date(event.timestamp).toLocaleString()} — {event.type}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {showApprove ? (
        <CeoApproveDialog
          baseUrl={baseUrl}
          plan={plan}
          version={activeVersion}
          mutationToken={mutationToken}
          onDecided={() => {
            setShowApprove(false);
            setAnnouncement("Plan approved. This does not start any agent.");
            void refresh();
          }}
          onClose={() => {
            setShowApprove(false);
          }}
        />
      ) : null}

      {showReject ? (
        <CeoRejectDialog
          baseUrl={baseUrl}
          plan={plan}
          version={activeVersion}
          mutationToken={mutationToken}
          onDecided={() => {
            setShowReject(false);
            setAnnouncement("Plan rejected.");
            void refresh();
          }}
          onClose={() => {
            setShowReject(false);
          }}
        />
      ) : null}

      {showDelegate ? (
        <CeoDelegateDialog
          baseUrl={baseUrl}
          plan={plan}
          version={activeVersion}
          mutationToken={mutationToken}
          onClose={(result) => {
            setShowDelegate(false);
            if (result) {
              setAnnouncement(
                `Delegated ${String(result.childTasks.length)} child tasks, all unstarted.`,
              );
            }
            void refresh();
          }}
        />
      ) : null}

      {showEditForm ? (
        <Dialog
          titleId={editFormTitleId}
          onClose={() => {
            setShowEditForm(false);
          }}
          maxWidthClassName="max-w-2xl"
        >
          <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto">
            <h2 id={editFormTitleId} className="text-lg font-semibold">
              Edit plan — save as new version
            </h2>
            <CeoPlanEditForm
              baseUrl={baseUrl}
              planId={planId}
              parentTaskId={plan.parentTaskId}
              mutationToken={mutationToken}
              currentVersion={activeVersion}
              onSaved={() => {
                setShowEditForm(false);
                setAnnouncement("New plan version saved.");
                void refresh();
              }}
              onCancel={() => {
                setShowEditForm(false);
              }}
            />
          </div>
        </Dialog>
      ) : null}

      {showDelete ? (
        <Dialog
          titleId={deleteDialogTitleId}
          onClose={() => {
            if (!busy) setShowDelete(false);
          }}
        >
          <div className="flex flex-col gap-4">
            <h2 id={deleteDialogTitleId} className="text-lg font-semibold">
              Delete plan
            </h2>
            <p className="text-sm text-stone-700 dark:text-stone-300">
              Delete this cancelled plan? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setShowDelete(false);
                }}
                className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
              >
                Keep plan
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void handleDelete();
                }}
                className="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-red-600"
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
