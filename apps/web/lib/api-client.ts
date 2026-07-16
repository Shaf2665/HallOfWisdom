import type { z } from "zod";
import type { TaskStatus } from "@hall-of-wisdom/protocol";
import {
  adapterSummarySchema,
  cancelTaskResponseSchema,
  createTaskResponseSchema,
  errorResponseSchema,
  healthResponseSchema,
  listAdaptersResponseSchema,
  listTasksResponseSchema,
  taskRecordSchema,
  type CancelTaskResponse,
  type CreateTaskResponse,
  type HealthResponse,
  type TaskRecord,
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
  readonly method: "GET" | "POST";
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

export { adapterSummarySchema };
export type { AdapterSummary } from "./api-schemas";
