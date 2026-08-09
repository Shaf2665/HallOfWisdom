import type { z } from "zod";
import type { TaskStatus } from "@hall-of-wisdom/protocol";
import {
  adapterSummarySchema,
  agentComparisonRecordSchema,
  cancelComparisonCandidateResponseSchema,
  cancelTaskResponseSchema,
  ceoPlanSchema,
  ceoPlanVersionSchema,
  communicationBoardSchema,
  communicationMessageSchema,
  configureCeoPlanRunResponseSchema,
  createCeoPlanResponseSchema,
  createTaskResponseSchema,
  decideCeoPlanApprovalResponseSchema,
  delegateCeoPlanResponseSchema,
  emergencyStopResponseSchema,
  ensureBoardResponseSchema,
  errorResponseSchema,
  getAdapterResponseSchema,
  getCeoPlanResponseSchema,
  getCeoPlanRunResponseSchema,
  healthResponseSchema,
  listAdaptersResponseSchema,
  listBoardMessagesResponseSchema,
  listBoardsResponseSchema,
  listCeoApprovalsResponseSchema,
  listCeoPlanEventsResponseSchema,
  listCeoPlanRunEventsResponseSchema,
  listCeoPlanRunsResponseSchema,
  listCeoPlansResponseSchema,
  listCeoPlanVersionsResponseSchema,
  listComparisonsResponseSchema,
  listTasksResponseSchema,
  ceoPlanRunSchedulerStatusResponseSchema,
  retryCeoPlanRunStepResponseSchema,
  routeAndAssignResponseSchema,
  routingAnalysisResponseSchema,
  runMutationResponseSchema,
  systemStorageResponseSchema,
  taskRecordSchema,
  type AgentComparisonRecord,
  type CancelComparisonCandidateResponse,
  type CancelTaskResponse,
  type CeoPlan,
  type CeoPlanExecutionMode,
  type CeoPlanExecutionPolicy,
  type CommunicationBoard,
  type CommunicationMessage,
  type ConfigureCeoPlanRunResponse,
  type CreateCeoPlanResponse,
  type CreateTaskResponse,
  type DecideCeoPlanApprovalResponse,
  type DelegateCeoPlanResponse,
  type EmergencyStopResponse,
  type EnsureBoardResponse,
  type GetCeoPlanResponse,
  type GetCeoPlanRunResponse,
  type HealthResponse,
  type ListBoardMessagesResponse,
  type ListBoardsResponse,
  type ListCeoApprovalsResponse,
  type ListCeoPlanEventsResponse,
  type ListCeoPlanRunEventsResponse,
  type ListCeoPlanRunsResponse,
  type ListCeoPlansResponse,
  type ListCeoPlanVersionsResponse,
  type ListComparisonsResponse,
  type CeoPlanRunSchedulerStatusResponse,
  type RetryCeoPlanRunStepResponse,
  type RouteAndAssignResponse,
  type RoutingAnalysisResponse,
  type RunMutationResponse,
  type SystemStorageResponse,
  type TaskRecord,
  type TaskRequirements,
} from "./api-schemas";

export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/**
 * A typed, safe error every API client function can throw. `code` is
 * either the server's own stable machine code (from a validated error
 * response body) or one of this client's own local codes (`TIMEOUT`,
 * `NETWORK_ERROR`, `INVALID_RESPONSE`) for failures that never reached a
 * parseable Hall Core response at all. `message` is always safe to show a
 * user directly — never a raw `Error`, a stack trace, or an unvalidated
 * response body.
 */
export class ApiClientError extends Error {
  readonly code: string;
  readonly statusCode: number | undefined;
  readonly details: readonly { readonly path: string; readonly message: string }[] | undefined;

  constructor(
    code: string,
    message: string,
    statusCode?: number,
    details?: readonly { readonly path: string; readonly message: string }[],
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface CreateTaskRequestBody {
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  readonly priority?: "low" | "normal" | "high" | "critical";
  readonly adapterId: string;
  readonly workingDirectory?: string;
}

export interface CreateDeferredTaskRequestBody {
  readonly projectId: string;
  readonly title: string;
  readonly description?: string;
  readonly priority?: "low" | "normal" | "high" | "critical";
  readonly workingDirectory?: string;
  readonly source?: "wisdom_gateway";
}

export interface AssignTaskRequestBody {
  readonly adapterId: string;
  readonly workingDirectory?: string;
}

interface RequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Combines a caller-supplied `AbortSignal` (if any) with an internally
 * owned timeout, without relying on `AbortSignal.any` (not universally
 * available across every target runtime this app might run test suites
 * under). `cleanup()` must be called on every exit path so the internal
 * timer and listener never outlive the request.
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  const controller = new AbortController();
  const onExternalAbort = (): void => {
    controller.abort(signal?.reason);
  };
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The request timed out.", "TimeoutError"));
  }, timeoutMs);
  const cleanup = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  };
  return { signal: controller.signal, cleanup };
}

interface RequestInit {
  readonly method: "GET" | "POST" | "DELETE";
  readonly body?: unknown;
}

/**
 * The one place every HTTP call in this app goes through. Validates every
 * successful response at runtime against `responseSchema` before handing
 * it to a caller — a component must never receive a value it merely
 * *hopes* matches its TypeScript type. Never logs a response body (a
 * failure detail could, in principle, contain something a real future
 * adapter captured that shouldn't be printed to the browser console).
 */
async function request<S extends z.ZodTypeAny>(
  url: string,
  init: RequestInit,
  responseSchema: S,
  options: RequestOptions,
): Promise<z.output<S>> {
  const { signal, cleanup } = withTimeout(
    options.signal,
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      ...(init.body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
      signal,
      credentials: "omit",
    });
  } catch {
    if (signal.aborted) {
      throw new ApiClientError("TIMEOUT", "The request to Hall Core timed out or was cancelled.");
    }
    throw new ApiClientError(
      "NETWORK_ERROR",
      "Could not reach Hall Core. Make sure it is running.",
    );
  } finally {
    cleanup();
  }

  const text = await response.text();
  let rawBody: unknown;
  if (text.length === 0) {
    rawBody = undefined;
  } else {
    try {
      rawBody = JSON.parse(text);
    } catch {
      throw new ApiClientError(
        "INVALID_RESPONSE",
        "Hall Core returned a response that was not valid JSON.",
        response.status,
      );
    }
  }

  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(rawBody);
    if (parsedError.success) {
      throw new ApiClientError(
        parsedError.data.error.code,
        parsedError.data.error.message,
        response.status,
        parsedError.data.error.details,
      );
    }
    throw new ApiClientError(
      "SERVER_ERROR",
      "Hall Core returned an unexpected error.",
      response.status,
    );
  }

  const parsed = responseSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "Hall Core returned a response with an unexpected shape.",
      response.status,
    );
  }
  return parsed.data as z.output<S>;
}

export function getHealth(baseUrl: string, options: RequestOptions = {}): Promise<HealthResponse> {
  return request(`${baseUrl}/api/v1/health`, { method: "GET" }, healthResponseSchema, options);
}

export function getSystemStorage(
  baseUrl: string,
  options: RequestOptions = {},
): Promise<SystemStorageResponse> {
  return request(
    `${baseUrl}/api/v1/system/storage`,
    { method: "GET" },
    systemStorageResponseSchema,
    options,
  );
}

export function listAdapters(
  baseUrl: string,
  options: RequestOptions = {},
): Promise<z.infer<typeof listAdaptersResponseSchema>> {
  return request(
    `${baseUrl}/api/v1/adapters`,
    { method: "GET" },
    listAdaptersResponseSchema,
    options,
  );
}

export function getAdapter(
  baseUrl: string,
  adapterId: string,
  options: RequestOptions = {},
): Promise<z.infer<typeof getAdapterResponseSchema>> {
  return request(
    `${baseUrl}/api/v1/adapters/${encodeURIComponent(adapterId)}`,
    { method: "GET" },
    getAdapterResponseSchema,
    options,
  );
}

export function createTask(
  baseUrl: string,
  body: CreateTaskRequestBody,
  options: RequestOptions = {},
): Promise<CreateTaskResponse> {
  return request(
    `${baseUrl}/api/v1/tasks`,
    { method: "POST", body },
    createTaskResponseSchema,
    options,
  );
}

export function listTasks(
  baseUrl: string,
  options: RequestOptions = {},
): Promise<z.infer<typeof listTasksResponseSchema>> {
  return request(`${baseUrl}/api/v1/tasks`, { method: "GET" }, listTasksResponseSchema, options);
}

export function getTask(
  baseUrl: string,
  taskId: string,
  options: RequestOptions = {},
): Promise<TaskRecord> {
  return request(
    `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`,
    { method: "GET" },
    taskRecordSchema,
    options,
  );
}

export function cancelTask(
  baseUrl: string,
  taskId: string,
  options: RequestOptions = {},
): Promise<CancelTaskResponse> {
  return request(
    `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
    { method: "POST" },
    cancelTaskResponseSchema,
    options,
  );
}

/** Creates a planning-only task in `backlog` — no adapter, no run, no execution started. */
export function createDeferredTask(
  baseUrl: string,
  body: CreateDeferredTaskRequestBody,
  options: RequestOptions = {},
): Promise<CreateTaskResponse> {
  return request(
    `${baseUrl}/api/v1/tasks`,
    { method: "POST", body: { ...body, executionMode: "deferred" } },
    createTaskResponseSchema,
    options,
  );
}

/** A manual planning-state move (never running/reviewing/waiting_for_approval/completed/failed). */
export function transitionTask(
  baseUrl: string,
  taskId: string,
  targetStatus: TaskStatus,
  options: RequestOptions = {},
): Promise<TaskRecord> {
  return request(
    `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/transition`,
    { method: "POST", body: { targetStatus } },
    taskRecordSchema,
    options,
  );
}

/** Assigns (or, before start, reassigns) an adapter to a `ready` task. Starts nothing. */
export function assignTask(
  baseUrl: string,
  taskId: string,
  body: AssignTaskRequestBody,
  options: RequestOptions = {},
): Promise<TaskRecord> {
  return request(
    `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/assign`,
    { method: "POST", body },
    taskRecordSchema,
    options,
  );
}

/** Starts execution for a task already assigned via `assignTask()`. */
export function startTask(
  baseUrl: string,
  taskId: string,
  options: RequestOptions = {},
): Promise<CreateTaskResponse> {
  return request(
    `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/start`,
    { method: "POST" },
    createTaskResponseSchema,
    options,
  );
}

/**
 * Phase 11 — read-only capability/trust routing analysis: never mutates
 * anything server-side. `requirements`, if supplied, overrides (but never
 * persists) the task's own `requirements` for this one call — lets the
 * "Find suitable agent" dialog preview against a freshly chosen profile
 * even for a task that has none saved yet.
 */
export function getRoutingAnalysis(
  baseUrl: string,
  taskId: string,
  requirements?: TaskRequirements,
  options: RequestOptions = {},
): Promise<RoutingAnalysisResponse> {
  return request(
    `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/routing-analysis`,
    { method: "POST", ...(requirements === undefined ? {} : { body: { requirements } }) },
    routingAnalysisResponseSchema,
    options,
  );
}

/**
 * Phase 11 — the one explicit, mutating routing action: assigns the
 * recommended adapter, exactly like `assignTask()`. Never starts
 * execution — `startTask()` remains a separate, always-manual call.
 */
export function routeAndAssign(
  baseUrl: string,
  taskId: string,
  requirements?: TaskRequirements,
  options: RequestOptions = {},
): Promise<RouteAndAssignResponse> {
  return request(
    `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/route-and-assign`,
    { method: "POST", ...(requirements === undefined ? {} : { body: { requirements } }) },
    routeAndAssignResponseSchema,
    options,
  );
}

export function listBoards(
  baseUrl: string,
  options: RequestOptions = {},
): Promise<ListBoardsResponse> {
  return request(`${baseUrl}/api/v1/boards`, { method: "GET" }, listBoardsResponseSchema, options);
}

export function getBoard(
  baseUrl: string,
  boardId: string,
  options: RequestOptions = {},
): Promise<CommunicationBoard> {
  return request(
    `${baseUrl}/api/v1/boards/${encodeURIComponent(boardId)}`,
    { method: "GET" },
    communicationBoardSchema,
    options,
  );
}

/** Ensures a discussion board exists for `taskId` — idempotent; never starts, assigns, or cancels anything. */
export function ensureTaskBoard(
  baseUrl: string,
  taskId: string,
  options: RequestOptions = {},
): Promise<EnsureBoardResponse> {
  return request(
    `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/board`,
    { method: "POST" },
    ensureBoardResponseSchema,
    options,
  );
}

export function listBoardMessages(
  baseUrl: string,
  boardId: string,
  afterSequence?: number,
  options: RequestOptions = {},
): Promise<ListBoardMessagesResponse> {
  const query = afterSequence === undefined ? "" : `?afterSequence=${String(afterSequence)}`;
  return request(
    `${baseUrl}/api/v1/boards/${encodeURIComponent(boardId)}/messages${query}`,
    { method: "GET" },
    listBoardMessagesResponseSchema,
    options,
  );
}

export function createBoardMessage(
  baseUrl: string,
  boardId: string,
  text: string,
  options: RequestOptions = {},
): Promise<CommunicationMessage> {
  return request(
    `${baseUrl}/api/v1/boards/${encodeURIComponent(boardId)}/messages`,
    { method: "POST", body: { text } },
    communicationMessageSchema,
    options,
  );
}

export interface CreateComparisonRequestBody {
  readonly sourceTaskId: string;
  readonly candidateAdapterIds: readonly [string, string];
}

export interface SetComparisonPreferenceRequestBody {
  /** `null` clears any previously recorded preference. */
  readonly candidateId: string | null;
  readonly note?: string;
}

/**
 * Phase 12 — controlled multi-agent execution comparison. Creates a
 * comparison only (source task snapshotted, two pending candidates
 * registered) — no filesystem/Git work happens until `prepareComparison()`
 * is called, and no candidate is ever started here.
 */
export function createComparison(
  baseUrl: string,
  body: CreateComparisonRequestBody,
  options: RequestOptions = {},
): Promise<AgentComparisonRecord> {
  return request(
    `${baseUrl}/api/v1/comparisons`,
    { method: "POST", body },
    agentComparisonRecordSchema,
    options,
  );
}

export function listComparisons(
  baseUrl: string,
  options: RequestOptions = {},
): Promise<ListComparisonsResponse> {
  return request(
    `${baseUrl}/api/v1/comparisons`,
    { method: "GET" },
    listComparisonsResponseSchema,
    options,
  );
}

export function getComparison(
  baseUrl: string,
  comparisonId: string,
  options: RequestOptions = {},
): Promise<AgentComparisonRecord> {
  return request(
    `${baseUrl}/api/v1/comparisons/${encodeURIComponent(comparisonId)}`,
    { method: "GET" },
    agentComparisonRecordSchema,
    options,
  );
}

/** Resolves the shared base commit and creates both candidates' worktrees. Starts nothing. */
export function prepareComparison(
  baseUrl: string,
  comparisonId: string,
  options: RequestOptions = {},
): Promise<AgentComparisonRecord> {
  return request(
    `${baseUrl}/api/v1/comparisons/${encodeURIComponent(comparisonId)}/prepare`,
    { method: "POST" },
    agentComparisonRecordSchema,
    options,
  );
}

/**
 * Starts exactly one candidate's run. The server enforces sequential-only
 * execution (409 `COMPARISON_STATE_CONFLICT` if another candidate on this
 * comparison is already running) — this function does not pre-check that
 * client-side; callers must surface a rejected promise as an inline error.
 */
export function startComparisonCandidate(
  baseUrl: string,
  comparisonId: string,
  candidateId: string,
  options: RequestOptions = {},
): Promise<AgentComparisonRecord> {
  return request(
    `${baseUrl}/api/v1/comparisons/${encodeURIComponent(comparisonId)}/candidates/${encodeURIComponent(candidateId)}/start`,
    { method: "POST" },
    agentComparisonRecordSchema,
    options,
  );
}

export function cancelComparisonCandidate(
  baseUrl: string,
  comparisonId: string,
  candidateId: string,
  options: RequestOptions = {},
): Promise<CancelComparisonCandidateResponse> {
  return request(
    `${baseUrl}/api/v1/comparisons/${encodeURIComponent(comparisonId)}/candidates/${encodeURIComponent(candidateId)}/cancel`,
    { method: "POST" },
    cancelComparisonCandidateResponseSchema,
    options,
  );
}

/**
 * Records (or, with `candidateId: null`, clears) a purely informational
 * operator preference — never merges, commits, or picks a winner. See
 * `docs/architecture/0012-controlled-agent-comparison.md`.
 */
export function setComparisonPreference(
  baseUrl: string,
  comparisonId: string,
  body: SetComparisonPreferenceRequestBody,
  options: RequestOptions = {},
): Promise<AgentComparisonRecord> {
  return request(
    `${baseUrl}/api/v1/comparisons/${encodeURIComponent(comparisonId)}/preference`,
    { method: "POST", body },
    agentComparisonRecordSchema,
    options,
  );
}

/** Tears down both worktrees. Always returns the record (never throws on a partial failure) — a failed cleanup is retry-safe via a second call. */
export function deleteComparison(
  baseUrl: string,
  comparisonId: string,
  options: RequestOptions = {},
): Promise<AgentComparisonRecord> {
  return request(
    `${baseUrl}/api/v1/comparisons/${encodeURIComponent(comparisonId)}`,
    { method: "DELETE" },
    agentComparisonRecordSchema,
    options,
  );
}

/**
 * Phase 14 — the CEO Agent control plane. Every mutating function below
 * does exactly one thing, matching the server route it calls one-to-one
 * (`routes/ceo-plans.ts`): `createCeoPlan` only ever generates a draft
 * (never a child task, never an adapter assignment), `approveCeoPlan`
 * only ever records a decision (never starts anything), and
 * `delegateCeoPlan` is the one function that creates child tasks — always
 * left unstarted. See `docs/architecture/0014-ceo-planning-approval-and-delegation.md`.
 */
export interface CreateCeoPlanRequestBody {
  readonly planningInstructions?: string;
}

export function createCeoPlan(
  baseUrl: string,
  taskId: string,
  body: CreateCeoPlanRequestBody = {},
  options: RequestOptions = {},
): Promise<CreateCeoPlanResponse> {
  return request(
    `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/ceo-plans`,
    { method: "POST", body },
    createCeoPlanResponseSchema,
    options,
  );
}

export function listCeoPlans(
  baseUrl: string,
  options: RequestOptions = {},
): Promise<ListCeoPlansResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plans`,
    { method: "GET" },
    listCeoPlansResponseSchema,
    options,
  );
}

export function getCeoPlan(
  baseUrl: string,
  planId: string,
  options: RequestOptions = {},
): Promise<GetCeoPlanResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}`,
    { method: "GET" },
    getCeoPlanResponseSchema,
    options,
  );
}

export function listCeoPlanVersions(
  baseUrl: string,
  planId: string,
  options: RequestOptions = {},
): Promise<ListCeoPlanVersionsResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/versions`,
    { method: "GET" },
    listCeoPlanVersionsResponseSchema,
    options,
  );
}

export function getCeoPlanVersion(
  baseUrl: string,
  planId: string,
  version: number,
  options: RequestOptions = {},
): Promise<z.infer<typeof ceoPlanVersionSchema>> {
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/versions/${String(version)}`,
    { method: "GET" },
    ceoPlanVersionSchema,
    options,
  );
}

export function listCeoApprovals(
  baseUrl: string,
  planId: string,
  options: RequestOptions = {},
): Promise<ListCeoApprovalsResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/approvals`,
    { method: "GET" },
    listCeoApprovalsResponseSchema,
    options,
  );
}

export function listCeoPlanEvents(
  baseUrl: string,
  planId: string,
  afterSequence?: number,
  options: RequestOptions = {},
): Promise<ListCeoPlanEventsResponse> {
  const query = afterSequence === undefined ? "" : `?afterSequence=${String(afterSequence)}`;
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/events${query}`,
    { method: "GET" },
    listCeoPlanEventsResponseSchema,
    options,
  );
}

export interface CeoPlanStepEditInput {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly objective: string;
  readonly boundedInstructions: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependencies: readonly string[];
  readonly requirements?: TaskRequirements;
  readonly selectedAdapterId?: string;
}

export interface CreateCeoPlanVersionRequestBody {
  readonly expectedMutationToken: string;
  readonly objective: string;
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly constraints: readonly string[];
  readonly steps: readonly CeoPlanStepEditInput[];
}

/** Revises a draft/rejected plan into a new immutable version — never mutates the previous one. Any prior approval is invalidated server-side. */
export function createCeoPlanVersion(
  baseUrl: string,
  planId: string,
  body: CreateCeoPlanVersionRequestBody,
  options: RequestOptions = {},
): Promise<CreateCeoPlanResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/versions`,
    { method: "POST", body },
    createCeoPlanResponseSchema,
    options,
  );
}

/** Submits the active draft/rejected version for human approval. Creates no child task, starts nothing. */
export function submitCeoPlan(
  baseUrl: string,
  planId: string,
  expectedMutationToken: string,
  options: RequestOptions = {},
): Promise<CeoPlan> {
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/submit`,
    { method: "POST", body: { expectedMutationToken } },
    ceoPlanSchema,
    options,
  );
}

export interface DecideCeoPlanApprovalRequestBody {
  readonly expectedMutationToken: string;
  readonly planVersion: number;
  readonly contentHash: string;
  readonly operatorNote?: string;
}

/** Records an explicit human approval, bound to the exact version and content hash the operator reviewed. Never starts an adapter. */
export function approveCeoPlan(
  baseUrl: string,
  planId: string,
  body: DecideCeoPlanApprovalRequestBody,
  options: RequestOptions = {},
): Promise<DecideCeoPlanApprovalResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/approve`,
    { method: "POST", body },
    decideCeoPlanApprovalResponseSchema,
    options,
  );
}

/** Records an explicit human rejection. The plan may later be revised into a new draft version via `createCeoPlanVersion`. */
export function rejectCeoPlan(
  baseUrl: string,
  planId: string,
  body: DecideCeoPlanApprovalRequestBody,
  options: RequestOptions = {},
): Promise<DecideCeoPlanApprovalResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/reject`,
    { method: "POST", body },
    decideCeoPlanApprovalResponseSchema,
    options,
  );
}

/** Creates and assigns one child task per approved plan step. Every child task is left unstarted — starting remains a separate, explicit operator action on the Kanban board. */
export function delegateCeoPlan(
  baseUrl: string,
  planId: string,
  expectedMutationToken: string,
  options: RequestOptions = {},
): Promise<DelegateCeoPlanResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/delegate`,
    { method: "POST", body: { expectedMutationToken } },
    delegateCeoPlanResponseSchema,
    options,
  );
}

/** Cancels a plan before delegation. Does not exist to cancel already-delegated child tasks — those are cancelled individually, on the Kanban board. */
export function cancelCeoPlan(
  baseUrl: string,
  planId: string,
  expectedMutationToken: string,
  options: RequestOptions = {},
): Promise<CeoPlan> {
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/cancel`,
    { method: "POST", body: { expectedMutationToken } },
    ceoPlanSchema,
    options,
  );
}

/**
 * Phase 15 — autonomous execution of an already-delegated CEO plan. Every
 * mutating function below matches a `routes/ceo-plan-runs.ts` route
 * one-to-one: `configureCeoPlanRunExecution` creates a run but starts
 * nothing (`.../start` is the one route that lets the scheduler begin
 * claiming signals), `retryCeoPlanRunStep` is the only route that can move
 * a stuck step back toward execution, and none of these functions ever
 * accept an actor identity — the server always attributes the resulting
 * event to the fixed `"human:local-operator"` actor.
 */
export interface ConfigureCeoPlanRunRequestBody {
  readonly executionMode: CeoPlanExecutionMode;
  readonly policy: CeoPlanExecutionPolicy;
}

/** Creates an execution run for an already-delegated plan. Configuration alone starts no task run. */
export function configureCeoPlanRunExecution(
  baseUrl: string,
  planId: string,
  body: ConfigureCeoPlanRunRequestBody,
  options: RequestOptions = {},
): Promise<ConfigureCeoPlanRunResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/execution/configure`,
    { method: "POST", body },
    configureCeoPlanRunResponseSchema,
    options,
  );
}

export function listCeoPlanRuns(
  baseUrl: string,
  options: RequestOptions = {},
): Promise<ListCeoPlanRunsResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plan-runs`,
    { method: "GET" },
    listCeoPlanRunsResponseSchema,
    options,
  );
}

export function getCeoPlanRun(
  baseUrl: string,
  runId: string,
  options: RequestOptions = {},
): Promise<GetCeoPlanRunResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plan-runs/${encodeURIComponent(runId)}`,
    { method: "GET" },
    getCeoPlanRunResponseSchema,
    options,
  );
}

export function listCeoPlanRunEvents(
  baseUrl: string,
  runId: string,
  afterSequence?: number,
  options: RequestOptions = {},
): Promise<ListCeoPlanRunEventsResponse> {
  const query = afterSequence === undefined ? "" : `?afterSequence=${String(afterSequence)}`;
  return request(
    `${baseUrl}/api/v1/ceo-plan-runs/${encodeURIComponent(runId)}/events${query}`,
    { method: "GET" },
    listCeoPlanRunEventsResponseSchema,
    options,
  );
}

export function getCeoPlanRunSchedulerStatus(
  baseUrl: string,
  runId: string,
  options: RequestOptions = {},
): Promise<CeoPlanRunSchedulerStatusResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plan-runs/${encodeURIComponent(runId)}/scheduler-status`,
    { method: "GET" },
    ceoPlanRunSchedulerStatusResponseSchema,
    options,
  );
}

/** The one route that lets the scheduler begin claiming signals for this run — a `manual`-mode run still starts nothing on its own even after this call. */
export function startCeoPlanRun(
  baseUrl: string,
  runId: string,
  expectedMutationToken: string,
  options: RequestOptions = {},
): Promise<RunMutationResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plan-runs/${encodeURIComponent(runId)}/start`,
    { method: "POST", body: { expectedMutationToken } },
    runMutationResponseSchema,
    options,
  );
}

/** Pauses scheduling. Already-active child tasks are left running under their own steam — nothing is force-cancelled. */
export function pauseCeoPlanRun(
  baseUrl: string,
  runId: string,
  expectedMutationToken: string,
  options: RequestOptions = {},
): Promise<RunMutationResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plan-runs/${encodeURIComponent(runId)}/pause`,
    { method: "POST", body: { expectedMutationToken } },
    runMutationResponseSchema,
    options,
  );
}

export function resumeCeoPlanRun(
  baseUrl: string,
  runId: string,
  expectedMutationToken: string,
  options: RequestOptions = {},
): Promise<RunMutationResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plan-runs/${encodeURIComponent(runId)}/resume`,
    { method: "POST", body: { expectedMutationToken } },
    runMutationResponseSchema,
    options,
  );
}

/** Stops future scheduling for this run. Does not cancel already-active child tasks — use emergency stop for that. */
export function cancelCeoPlanRun(
  baseUrl: string,
  runId: string,
  expectedMutationToken: string,
  options: RequestOptions = {},
): Promise<RunMutationResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plan-runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST", body: { expectedMutationToken } },
    runMutationResponseSchema,
    options,
  );
}

/** Stops future scheduling AND requests cancellation of every currently active child task linked to this run. */
export function emergencyStopCeoPlanRun(
  baseUrl: string,
  runId: string,
  expectedMutationToken: string,
  options: RequestOptions = {},
): Promise<EmergencyStopResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plan-runs/${encodeURIComponent(runId)}/emergency-stop`,
    { method: "POST", body: { expectedMutationToken } },
    emergencyStopResponseSchema,
    options,
  );
}

/** Manually retries one step currently `failed` or `awaiting_intervention`. The only route that can move a stuck step back toward execution. */
export function retryCeoPlanRunStep(
  baseUrl: string,
  runId: string,
  stepId: string,
  expectedMutationToken: string,
  options: RequestOptions = {},
): Promise<RetryCeoPlanRunStepResponse> {
  return request(
    `${baseUrl}/api/v1/ceo-plan-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/retry`,
    { method: "POST", body: { expectedMutationToken } },
    retryCeoPlanRunStepResponseSchema,
    options,
  );
}

export type {
  CeoPlanExecutionMode,
  CeoPlanExecutionPolicy,
  CeoPlanRunSchedulerStatusResponse,
  ConfigureCeoPlanRunResponse,
  EmergencyStopResponse,
  GetCeoPlanRunResponse,
  ListCeoPlanRunEventsResponse,
  ListCeoPlanRunsResponse,
  RetryCeoPlanRunStepResponse,
  RunMutationResponse,
} from "./api-schemas";

export { adapterSummarySchema };
export type { AdapterSummary } from "./api-schemas";
