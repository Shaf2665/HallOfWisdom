"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import {
  approveCeoPlan,
  createCeoPlan,
  createCeoPlanVersion,
  createDeferredTask,
  delegateCeoPlan,
  getCeoPlan,
  getCeoPlanVersion,
  listCeoPlans,
  listTasks,
  submitCeoPlan,
} from "../lib/api-client";
import type { CeoDelegationLink, CeoPlan, CeoPlanVersion } from "../lib/api-schemas";
import { CeoPlanSummaryCard } from "./ceo/ceo-plan-summary-card";
import { stepsWithAgentChoices, type AgentSelections } from "./ceo/ceo-plan-versioning";
import { GatewayOverview } from "./gateway-overview";

const NEW_PROJECT = "__hall_new_project__";
const MAX_PROJECT_LENGTH = 128;
const MAX_REQUEST_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 200;
const MAX_RECENT_REQUESTS = 10;

type MessageStatus = "sending" | "planning_started" | "request_failed" | "planning_failed";
type PlanAction = "continuing" | "approving" | "saving_agent_choices" | "preparing";

interface ConversationEntry {
  readonly id: string;
  readonly projectName: string;
  readonly request: string;
  readonly status: MessageStatus;
  readonly parentTaskId?: string;
  readonly plan?: CeoPlan;
  readonly version?: CeoPlanVersion | undefined;
  readonly mutationToken?: string | undefined;
  readonly links: readonly CeoDelegationLink[];
  readonly planAction: PlanAction | null;
  readonly planActionError: string | null;
  readonly approvalConfirmed: boolean;
  readonly prepareConfirmed: boolean;
}

interface PlanResult {
  readonly plan: CeoPlan;
  readonly version?: CeoPlanVersion | undefined;
  readonly mutationToken?: string | undefined;
  readonly links: readonly CeoDelegationLink[];
}

interface CurrentPlanResult extends PlanResult {
  readonly version: CeoPlanVersion;
  readonly mutationToken: string;
}

function requestTitle(request: string): string {
  const firstLine = request.trim().split(/\r?\n/, 1)[0] ?? request.trim();
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function statusCopy(status: MessageStatus): string {
  switch (status) {
    case "sending":
      return "I’ve received your request. I’m saving it and starting the plan now…";
    case "planning_started":
      return "Your plan is ready to review.";
    case "request_failed":
      return "I couldn’t send that request to Hall. Check that Hall is online, then try again.";
    case "planning_failed":
      return "Your request is safely saved, but planning couldn’t start. You can try planning again without resending it.";
  }
}

async function loadPlanResult(
  baseUrl: string,
  knownPlan: CeoPlan,
  signal?: AbortSignal,
): Promise<PlanResult> {
  let plan = knownPlan;
  let mutationToken: string | undefined;
  let links: readonly CeoDelegationLink[] = [];
  try {
    const detail = await getCeoPlan(baseUrl, knownPlan.id, { signal });
    plan = detail.plan;
    mutationToken = detail.mutationToken;
    links = detail.links;
  } catch {
    // The list/create response is already a validated plan snapshot. Keep
    // it so navigation remains available even if this refresh fails.
  }

  try {
    const version = await getCeoPlanVersion(baseUrl, plan.id, plan.activeVersion, { signal });
    return { plan, version, mutationToken, links };
  } catch {
    return { plan, mutationToken, links };
  }
}

async function loadCurrentPlanResult(baseUrl: string, planId: string): Promise<CurrentPlanResult> {
  const detail = await getCeoPlan(baseUrl, planId);
  const version = await getCeoPlanVersion(baseUrl, planId, detail.plan.activeVersion);
  if (version.version !== detail.plan.activeVersion) {
    throw new Error("The active CEO plan version changed while it was being loaded.");
  }
  return {
    plan: detail.plan,
    version,
    mutationToken: detail.mutationToken,
    links: detail.links,
  };
}

function hasUsableActionContext(result: PlanResult): boolean {
  if (result.mutationToken === undefined) return false;
  return result.version?.version === result.plan.activeVersion;
}

export function WisdomGateway({
  baseUrl,
  wsBaseUrl,
}: {
  readonly baseUrl: string;
  readonly wsBaseUrl: string;
}) {
  const formId = useId();
  const nextMessageId = useRef(1);
  const [projects, setProjects] = useState<readonly string[]>([]);
  const [projectsState, setProjectsState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedProject, setSelectedProject] = useState(NEW_PROJECT);
  const [newProjectName, setNewProjectName] = useState("");
  const [request, setRequest] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busyMessageId, setBusyMessageId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<readonly ConversationEntry[]>([]);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const controller = new AbortController();
    const tasksRequest = listTasks(baseUrl, { signal: controller.signal });
    const plansRequest = listCeoPlans(baseUrl, { signal: controller.signal });

    tasksRequest
      .then(({ tasks }) => {
        if (controller.signal.aborted) return;
        const discoveredProjects = [...new Set(tasks.map((record) => record.task.projectId))].sort(
          (left, right) => left.localeCompare(right),
        );
        setProjects(discoveredProjects);
        setSelectedProject(discoveredProjects[0] ?? NEW_PROJECT);
        setProjectsState("ready");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSelectedProject(NEW_PROJECT);
        setProjectsState("error");
      });

    Promise.all([tasksRequest, plansRequest])
      .then(async ([{ tasks }, { plans }]) => {
        const latestPlanByParentTask = new Map<string, CeoPlan>();
        for (const plan of plans) {
          const current = latestPlanByParentTask.get(plan.parentTaskId);
          if (current === undefined || current.createdAt < plan.createdAt) {
            latestPlanByParentTask.set(plan.parentTaskId, plan);
          }
        }

        const recentGatewayTasks = tasks
          .filter((record) => record.task.source === "wisdom_gateway")
          .sort((left, right) => right.task.createdAt.localeCompare(left.task.createdAt))
          .slice(0, MAX_RECENT_REQUESTS)
          .reverse();

        const restoredConversation = await Promise.all(
          recentGatewayTasks.map(async (record): Promise<ConversationEntry> => {
            const linkedPlan = latestPlanByParentTask.get(record.task.taskId);
            if (linkedPlan === undefined) {
              return {
                id: `task-${record.task.taskId}`,
                projectName: record.task.projectId,
                request: record.task.description,
                status: "planning_failed",
                parentTaskId: record.task.taskId,
                links: [],
                planAction: null,
                planActionError: null,
                approvalConfirmed: false,
                prepareConfirmed: false,
              };
            }

            const result = await loadPlanResult(baseUrl, linkedPlan, controller.signal);
            return {
              id: `task-${record.task.taskId}`,
              projectName: record.task.projectId,
              request: record.task.description,
              status: "planning_started",
              parentTaskId: record.task.taskId,
              plan: result.plan,
              ...(result.version !== undefined ? { version: result.version } : {}),
              ...(result.mutationToken !== undefined
                ? { mutationToken: result.mutationToken }
                : {}),
              links: result.links,
              planAction: null,
              planActionError: null,
              approvalConfirmed: false,
              prepareConfirmed: false,
            };
          }),
        );

        if (controller.signal.aborted) return;
        setConversation((current) => [
          ...restoredConversation,
          ...current.filter((entry) => entry.id.startsWith("local-")),
        ]);
        setHistoryState("ready");
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setHistoryState("error");
      });

    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  function updateMessage(
    messageId: string,
    update: (entry: ConversationEntry) => ConversationEntry,
  ): void {
    setConversation((current) =>
      current.map((entry) => (entry.id === messageId ? update(entry) : entry)),
    );
  }

  async function startPlanning(messageId: string, parentTaskId: string): Promise<void> {
    setBusyMessageId(messageId);
    updateMessage(messageId, (entry) => ({ ...entry, status: "sending", parentTaskId }));
    try {
      const created = await createCeoPlan(baseUrl, parentTaskId);
      const result = await loadPlanResult(baseUrl, created.plan);
      updateMessage(messageId, (entry) => ({
        ...entry,
        status: "planning_started",
        plan: result.plan,
        version:
          result.version ??
          (created.version.version === result.plan.activeVersion ? created.version : undefined),
        mutationToken: result.mutationToken,
        links: result.links,
        planActionError: null,
        approvalConfirmed: false,
        prepareConfirmed: false,
      }));
    } catch {
      updateMessage(messageId, (entry) => ({ ...entry, status: "planning_failed" }));
    } finally {
      setBusyMessageId(null);
    }
  }

  async function refreshAfterMutationFailure(
    messageId: string,
    knownPlan: CeoPlan,
    startingStatus: CeoPlan["status"],
    completedStatus: CeoPlan["status"],
    retryCopy: string,
  ): Promise<void> {
    const refreshed = await loadPlanResult(baseUrl, knownPlan);
    let actionError: string | null;
    if (refreshed.plan.status === completedStatus) {
      actionError = null;
    } else if (refreshed.plan.status !== startingStatus) {
      actionError = "The plan changed while you were viewing it. Here is the latest status.";
    } else if (!hasUsableActionContext(refreshed)) {
      actionError =
        "Hall couldn’t confirm the latest plan status. Reload this page before trying again.";
    } else {
      actionError = retryCopy;
    }

    updateMessage(messageId, (entry) => ({
      ...entry,
      status: "planning_started",
      plan: refreshed.plan,
      version: refreshed.version,
      mutationToken: refreshed.mutationToken,
      links: refreshed.links,
      planActionError: actionError,
      approvalConfirmed: false,
      prepareConfirmed: false,
    }));
  }

  async function refreshAfterMutationSuccess(
    messageId: string,
    mutatedPlan: CeoPlan,
    reviewedVersion: CeoPlanVersion,
    knownLinks: readonly CeoDelegationLink[] = [],
  ): Promise<void> {
    try {
      const refreshed = await loadCurrentPlanResult(baseUrl, mutatedPlan.id);
      updateMessage(messageId, (entry) => ({
        ...entry,
        status: "planning_started",
        plan: refreshed.plan,
        version: refreshed.version,
        mutationToken: refreshed.mutationToken,
        links: refreshed.links,
        planActionError: null,
        approvalConfirmed: false,
        prepareConfirmed: false,
      }));
    } catch {
      updateMessage(messageId, (entry) => ({
        ...entry,
        status: "planning_started",
        plan: mutatedPlan,
        version:
          reviewedVersion.version === mutatedPlan.activeVersion ? reviewedVersion : undefined,
        mutationToken: undefined,
        links: knownLinks,
        planActionError:
          "The plan moved forward, but Hall couldn’t refresh its latest status. Reload this page to continue.",
        approvalConfirmed: false,
        prepareConfirmed: false,
      }));
    }
  }

  async function continuePlan(
    messageId: string,
    knownPlan: CeoPlan,
    mutationToken: string,
    reviewedVersion: CeoPlanVersion,
  ): Promise<void> {
    if (busyMessageId !== null) return;
    setBusyMessageId(messageId);
    updateMessage(messageId, (entry) => ({
      ...entry,
      planAction: "continuing",
      planActionError: null,
      approvalConfirmed: false,
      prepareConfirmed: false,
    }));

    try {
      const submitted = await submitCeoPlan(baseUrl, knownPlan.id, mutationToken);
      await refreshAfterMutationSuccess(messageId, submitted, reviewedVersion);
    } catch {
      await refreshAfterMutationFailure(
        messageId,
        knownPlan,
        "draft",
        "awaiting_approval",
        "Hall couldn’t continue with the plan. Please try again.",
      );
    } finally {
      updateMessage(messageId, (entry) => ({ ...entry, planAction: null }));
      setBusyMessageId(null);
    }
  }

  async function approvePlan(
    messageId: string,
    knownPlan: CeoPlan,
    reviewedVersion: CeoPlanVersion,
    mutationToken: string,
  ): Promise<void> {
    if (busyMessageId !== null) return;
    setBusyMessageId(messageId);
    updateMessage(messageId, (entry) => ({
      ...entry,
      planAction: "approving",
      planActionError: null,
      approvalConfirmed: false,
      prepareConfirmed: false,
    }));

    try {
      const approved = await approveCeoPlan(baseUrl, knownPlan.id, {
        expectedMutationToken: mutationToken,
        planVersion: reviewedVersion.version,
        contentHash: reviewedVersion.contentHash,
      });
      await refreshAfterMutationSuccess(messageId, approved.plan, reviewedVersion);
    } catch {
      await refreshAfterMutationFailure(
        messageId,
        knownPlan,
        "awaiting_approval",
        "approved",
        "Hall couldn’t approve the plan. Please try again.",
      );
    } finally {
      updateMessage(messageId, (entry) => ({ ...entry, planAction: null }));
      setBusyMessageId(null);
    }
  }

  async function saveAgentChoices(
    messageId: string,
    knownPlan: CeoPlan,
    reviewedVersion: CeoPlanVersion,
    mutationToken: string,
    selections: AgentSelections,
  ): Promise<void> {
    if (busyMessageId !== null) return;
    const missingChoice = reviewedVersion.steps.some(
      (step) =>
        step.selectedAdapterId === undefined &&
        step.recommendedAdapterId === undefined &&
        selections[step.id] === undefined,
    );
    if (
      knownPlan.status !== "approved" ||
      reviewedVersion.version !== knownPlan.activeVersion ||
      missingChoice
    ) {
      return;
    }

    setBusyMessageId(messageId);
    updateMessage(messageId, (entry) => ({
      ...entry,
      planAction: "saving_agent_choices",
      planActionError: null,
      approvalConfirmed: false,
      prepareConfirmed: false,
    }));

    try {
      const created = await createCeoPlanVersion(baseUrl, knownPlan.id, {
        expectedMutationToken: mutationToken,
        objective: reviewedVersion.objective,
        summary: reviewedVersion.summary,
        assumptions: reviewedVersion.assumptions,
        constraints: reviewedVersion.constraints,
        steps: stepsWithAgentChoices(reviewedVersion, selections),
      });
      await refreshAfterMutationSuccess(messageId, created.plan, created.version);
    } catch {
      await refreshAfterMutationFailure(
        messageId,
        knownPlan,
        "approved",
        "draft",
        "Hall couldn’t save those agent choices. Please try again, or review the full plan.",
      );
    } finally {
      updateMessage(messageId, (entry) => ({ ...entry, planAction: null }));
      setBusyMessageId(null);
    }
  }

  async function prepareWork(
    messageId: string,
    knownPlan: CeoPlan,
    reviewedVersion: CeoPlanVersion,
    mutationToken: string,
  ): Promise<void> {
    if (busyMessageId !== null) return;
    const missingAgent = reviewedVersion.steps.some(
      (step) => step.selectedAdapterId === undefined && step.recommendedAdapterId === undefined,
    );
    if (
      knownPlan.status !== "approved" ||
      reviewedVersion.version !== knownPlan.activeVersion ||
      missingAgent
    ) {
      return;
    }

    setBusyMessageId(messageId);
    updateMessage(messageId, (entry) => ({
      ...entry,
      planAction: "preparing",
      planActionError: null,
      approvalConfirmed: false,
      prepareConfirmed: false,
    }));

    try {
      const delegated = await delegateCeoPlan(baseUrl, knownPlan.id, mutationToken);
      await refreshAfterMutationSuccess(
        messageId,
        delegated.plan,
        reviewedVersion,
        delegated.links,
      );
    } catch {
      await refreshAfterMutationFailure(
        messageId,
        knownPlan,
        "approved",
        "delegated",
        "Hall couldn’t prepare the work. An agent or the plan may need review.",
      );
    } finally {
      updateMessage(messageId, (entry) => ({ ...entry, planAction: null }));
      setBusyMessageId(null);
    }
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busyMessageId !== null) return;

    const trimmedRequest = request.trim();
    const projectName =
      selectedProject === NEW_PROJECT ? newProjectName.trim() : selectedProject.trim();

    if (projectsState === "loading") {
      setFormError("Please wait while Hall loads your projects.");
      return;
    }
    if (projectName.length === 0) {
      setFormError("Choose a project or give your new project a name.");
      return;
    }
    if (projectName.length > MAX_PROJECT_LENGTH) {
      setFormError(`Project names can be up to ${String(MAX_PROJECT_LENGTH)} characters.`);
      return;
    }
    if (trimmedRequest.length === 0) {
      setFormError("Tell Hall what you would like to accomplish.");
      return;
    }

    const messageId = `local-${String(nextMessageId.current)}`;
    nextMessageId.current += 1;
    setFormError(null);
    setBusyMessageId(messageId);
    setConversation((current) => [
      ...current,
      {
        id: messageId,
        projectName,
        request: trimmedRequest,
        status: "sending",
        links: [],
        planAction: null,
        planActionError: null,
        approvalConfirmed: false,
        prepareConfirmed: false,
      },
    ]);

    try {
      const parentTask = await createDeferredTask(baseUrl, {
        projectId: projectName,
        title: requestTitle(trimmedRequest),
        description: trimmedRequest,
        source: "wisdom_gateway",
      });
      updateMessage(messageId, (entry) => ({
        ...entry,
        parentTaskId: parentTask.task.taskId,
      }));

      try {
        const created = await createCeoPlan(baseUrl, parentTask.task.taskId);
        const result = await loadPlanResult(baseUrl, created.plan);
        updateMessage(messageId, (entry) => ({
          ...entry,
          status: "planning_started",
          plan: result.plan,
          version:
            result.version ??
            (created.version.version === result.plan.activeVersion ? created.version : undefined),
          mutationToken: result.mutationToken,
          links: result.links,
          planActionError: null,
          approvalConfirmed: false,
          prepareConfirmed: false,
        }));
        setRequest("");
        if (selectedProject === NEW_PROJECT && !projects.includes(projectName)) {
          setProjects((current) =>
            [...current, projectName].sort((left, right) => left.localeCompare(right)),
          );
          setSelectedProject(projectName);
          setNewProjectName("");
        }
      } catch {
        updateMessage(messageId, (entry) => ({ ...entry, status: "planning_failed" }));
      }
    } catch {
      updateMessage(messageId, (entry) => ({ ...entry, status: "request_failed" }));
    } finally {
      setBusyMessageId(null);
    }
  }

  const isBusy = busyMessageId !== null;

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-8 py-6 sm:py-12">
      <div className="space-y-3 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-amber-700 dark:text-amber-400">
          Wisdom Gateway
        </p>
        <h2 className="text-3xl font-semibold tracking-tight sm:text-5xl">
          What would you like Hall to accomplish?
        </h2>
        <p className="mx-auto max-w-2xl text-base leading-7 text-stone-600 dark:text-stone-300">
          Describe the outcome in your own words. Hall’s CEO will turn it into a plan for you.
        </p>
      </div>

      <GatewayOverview baseUrl={baseUrl} />

      {historyState === "loading" ? (
        <p role="status" className="text-center text-sm text-stone-500 dark:text-stone-400">
          Restoring your recent requests…
        </p>
      ) : historyState === "error" ? (
        <p
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          Recent requests couldn’t be restored. You can still send a new request.
        </p>
      ) : null}

      {conversation.length > 0 ? (
        <div aria-live="polite" aria-label="Conversation" className="flex flex-col gap-5">
          {conversation.map((entry) => {
            const isError = entry.status === "request_failed" || entry.status === "planning_failed";
            return (
              <article key={entry.id} className="flex flex-col gap-3">
                <div className="ml-auto max-w-[88%] rounded-2xl rounded-br-sm bg-amber-700 px-5 py-4 text-white shadow-sm">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-100">
                    You · {entry.projectName}
                  </p>
                  <p className="whitespace-pre-wrap text-sm leading-6 sm:text-base">
                    {entry.request}
                  </p>
                </div>
                <div
                  role={isError ? "alert" : "status"}
                  className={`mr-auto max-w-[88%] rounded-2xl rounded-bl-sm border px-5 py-4 shadow-sm ${
                    isError
                      ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
                      : "border-stone-200 bg-white text-stone-800 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-100"
                  }`}
                >
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                    Hall CEO
                  </p>
                  {entry.plan === undefined ? (
                    <p className="text-sm leading-6 sm:text-base">{statusCopy(entry.status)}</p>
                  ) : null}
                  {entry.plan ? (
                    <CeoPlanSummaryCard
                      baseUrl={baseUrl}
                      wsBaseUrl={wsBaseUrl}
                      plan={entry.plan}
                      {...(entry.version !== undefined ? { version: entry.version } : {})}
                      links={entry.links}
                      activeAction={entry.planAction}
                      actionError={entry.planActionError}
                      actionsDisabled={isBusy}
                      canContinue={
                        entry.mutationToken !== undefined &&
                        entry.version?.version === entry.plan.activeVersion
                      }
                      canApprove={
                        entry.mutationToken !== undefined &&
                        entry.version?.version === entry.plan.activeVersion
                      }
                      approvalConfirmed={entry.approvalConfirmed}
                      canPrepare={
                        entry.mutationToken !== undefined &&
                        entry.version?.version === entry.plan.activeVersion
                      }
                      prepareConfirmed={entry.prepareConfirmed}
                      onContinue={() => {
                        const plan = entry.plan;
                        const version = entry.version;
                        const mutationToken = entry.mutationToken;
                        if (
                          plan !== undefined &&
                          version?.version === plan.activeVersion &&
                          mutationToken !== undefined
                        ) {
                          void continuePlan(entry.id, plan, mutationToken, version);
                        }
                      }}
                      onApprovalConfirmedChange={(confirmed) => {
                        updateMessage(entry.id, (current) => ({
                          ...current,
                          approvalConfirmed: confirmed,
                          prepareConfirmed: false,
                          planActionError: null,
                        }));
                      }}
                      onApprove={() => {
                        const plan = entry.plan;
                        const version = entry.version;
                        const mutationToken = entry.mutationToken;
                        if (
                          plan !== undefined &&
                          version?.version === plan.activeVersion &&
                          mutationToken !== undefined &&
                          entry.approvalConfirmed
                        ) {
                          void approvePlan(entry.id, plan, version, mutationToken);
                        }
                      }}
                      onPrepareConfirmedChange={(confirmed) => {
                        updateMessage(entry.id, (current) => ({
                          ...current,
                          approvalConfirmed: false,
                          prepareConfirmed: confirmed,
                          planActionError: null,
                        }));
                      }}
                      onPrepare={() => {
                        const plan = entry.plan;
                        const version = entry.version;
                        const mutationToken = entry.mutationToken;
                        if (
                          plan !== undefined &&
                          version?.version === plan.activeVersion &&
                          mutationToken !== undefined &&
                          entry.prepareConfirmed
                        ) {
                          void prepareWork(entry.id, plan, version, mutationToken);
                        }
                      }}
                      onSaveAgentChoices={(selections) => {
                        const plan = entry.plan;
                        const version = entry.version;
                        const mutationToken = entry.mutationToken;
                        if (
                          plan !== undefined &&
                          version?.version === plan.activeVersion &&
                          mutationToken !== undefined
                        ) {
                          void saveAgentChoices(entry.id, plan, version, mutationToken, selections);
                        }
                      }}
                    />
                  ) : null}
                  {entry.status === "planning_failed" && entry.parentTaskId ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        const parentTaskId = entry.parentTaskId;
                        if (parentTaskId !== undefined) {
                          void startPlanning(entry.id, parentTaskId);
                        }
                      }}
                      className="mt-3 rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:hover:bg-red-950"
                    >
                      {busyMessageId === entry.id ? "Trying again…" : "Try planning again"}
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      <form
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        noValidate
        aria-labelledby={`${formId}-heading`}
        className="rounded-2xl border border-stone-200 bg-white p-5 shadow-xl shadow-stone-950/5 sm:p-7 dark:border-stone-800 dark:bg-stone-900 dark:shadow-black/20"
      >
        <h3 id={`${formId}-heading`} className="sr-only">
          Send a request to the CEO
        </h3>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label htmlFor={`${formId}-project`} className="text-sm font-semibold">
              Project
            </label>
            <select
              id={`${formId}-project`}
              value={selectedProject}
              disabled={projectsState === "loading" || isBusy}
              onChange={(event) => {
                setSelectedProject(event.target.value);
                setFormError(null);
              }}
              className="rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950"
            >
              {projectsState === "loading" ? <option>Loading projects…</option> : null}
              {projects.map((project) => (
                <option key={project} value={project}>
                  {project}
                </option>
              ))}
              {projectsState !== "loading" ? (
                <option value={NEW_PROJECT}>Start a new project…</option>
              ) : null}
            </select>
            {projectsState === "error" ? (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                Saved projects couldn’t be loaded. You can still start a new project.
              </p>
            ) : null}
          </div>

          {selectedProject === NEW_PROJECT && projectsState !== "loading" ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={`${formId}-new-project`} className="text-sm font-semibold">
                Project name
              </label>
              <input
                id={`${formId}-new-project`}
                type="text"
                maxLength={MAX_PROJECT_LENGTH}
                value={newProjectName}
                disabled={isBusy}
                onChange={(event) => {
                  setNewProjectName(event.target.value);
                  setFormError(null);
                }}
                placeholder="For example, Customer portal"
                className="rounded-xl border border-stone-300 bg-stone-50 px-4 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950"
              />
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <label htmlFor={`${formId}-request`} className="text-sm font-semibold">
              Your request
            </label>
            <textarea
              id={`${formId}-request`}
              value={request}
              disabled={isBusy}
              maxLength={MAX_REQUEST_LENGTH}
              rows={7}
              onChange={(event) => {
                setRequest(event.target.value);
                setFormError(null);
              }}
              placeholder="Tell Hall what success looks like. Add any context or constraints that matter."
              className="min-h-44 resize-y rounded-xl border border-stone-300 bg-stone-50 px-4 py-4 text-base leading-7 placeholder:text-stone-400 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:placeholder:text-stone-600"
            />
            <p className="text-right text-xs text-stone-500 dark:text-stone-400">
              {request.length.toLocaleString()} / {MAX_REQUEST_LENGTH.toLocaleString()}
            </p>
          </div>

          {formError ? (
            <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-400">
              {formError}
            </p>
          ) : null}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={isBusy || projectsState === "loading"}
              className="rounded-xl bg-amber-700 px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600 dark:hover:bg-amber-500"
            >
              {isBusy ? "Sending…" : "Send to CEO"}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
