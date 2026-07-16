import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  assignTask,
  cancelTask,
  createDeferredTask,
  createTask,
  getHealth,
  getTask,
  listAdapters,
  listTasks,
  startTask,
  transitionTask,
} from "./api-client";

const BASE_URL = "http://127.0.0.1:4310";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain" } });
}

describe("api-client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getHealth: returns the validated health body on success", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        application: "hall-core",
        protocolVersion: "0.1",
        uptimeSeconds: 5,
      }),
    );
    const result = await getHealth(BASE_URL);
    expect(result.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE_URL}/api/v1/health`,
      expect.objectContaining({ method: "GET", credentials: "omit" }),
    );
  });

  it("getHealth: surfaces an offline/network failure as a typed ApiClientError", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(getHealth(BASE_URL)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("listAdapters: validates the adapter list shape", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        adapters: [
          {
            adapterId: "hall.mock-agent",
            displayName: "Mock Agent",
            adapterVersion: "0.1.0",
            agentId: "mock-agent",
            agentDisplayName: "Mock Agent",
            integrationLevel: "native",
            supportedOperatingSystems: ["windows", "macos", "linux"],
            capabilities: {
              streaming: true,
              cancellation: true,
              sessionResume: false,
              toolEvents: true,
              fileEditing: false,
              shellExecution: false,
              subagents: false,
              mcp: false,
              acp: false,
            },
            availability: "available",
          },
        ],
      }),
    );
    const result = await listAdapters(BASE_URL);
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]?.adapterId).toBe("hall.mock-agent");
  });

  it("listAdapters: rejects a response with an invalid shape (extra unexpected field)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        adapters: [
          {
            adapterId: "hall.mock-agent",
            displayName: "Mock Agent",
            adapterVersion: "0.1.0",
            agentId: "mock-agent",
            agentDisplayName: "Mock Agent",
            integrationLevel: "native",
            supportedOperatingSystems: ["windows"],
            capabilities: {
              streaming: true,
              cancellation: true,
              sessionResume: false,
              toolEvents: true,
              fileEditing: false,
              shellExecution: false,
              subagents: false,
              mcp: false,
              acp: false,
            },
            availability: "available",
            executablePath: "C:\\should-not-be-here.exe",
          },
        ],
      }),
    );
    await expect(listAdapters(BASE_URL)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("listTasks: validates the task-list shape", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tasks: [] }));
    const result = await listTasks(BASE_URL);
    expect(result.tasks).toEqual([]);
  });

  it("createTask: handles the 202 Accepted response", async () => {
    const now = new Date().toISOString();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          task: {
            taskId: "task-1",
            projectId: "project-1",
            title: "Test",
            description: "",
            priority: "normal",
            status: "assigned",
            dependencyTaskIds: [],
            createdAt: now,
            updatedAt: now,
          },
          runId: "run-1",
          adapterId: "hall.mock-agent",
          agentId: "mock-agent",
          eventCount: 0,
          cancellationRequested: false,
          createdAt: now,
          eventsPath: "/api/v1/tasks/task-1/events",
        },
        202,
      ),
    );
    const result = await createTask(BASE_URL, {
      projectId: "project-1",
      title: "Test",
      adapterId: "hall.mock-agent",
    });
    expect(result.task.taskId).toBe("task-1");
    expect(result.eventsPath).toBe("/api/v1/tasks/task-1/events");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("cancelTask: handles the 202 Accepted response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ taskId: "task-1", cancellationRequested: true, alreadyRequested: false }, 202),
    );
    const result = await cancelTask(BASE_URL, "task-1");
    expect(result.alreadyRequested).toBe(false);
  });

  it("cancelTask: surfaces a 409 conflict as a typed, safe ApiClientError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "TASK_STATE_CONFLICT", message: "Task cannot be cancelled." } },
        409,
      ),
    );
    await expect(cancelTask(BASE_URL, "task-1")).rejects.toMatchObject({
      code: "TASK_STATE_CONFLICT",
      statusCode: 409,
    });
  });

  it("getTask: surfaces a 404 unknown-task error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "TASK_NOT_FOUND", message: "No such task." } }, 404),
    );
    await expect(getTask(BASE_URL, "nonexistent")).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("rejects malformed success JSON", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("{not valid json"));
    await expect(getHealth(BASE_URL)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects malformed error JSON (still throws a safe, typed error)", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("{not valid json", 500));
    await expect(getHealth(BASE_URL)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("handles a non-JSON response body", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("<html>not json</html>", 500));
    await expect(getHealth(BASE_URL)).rejects.toBeInstanceOf(ApiClientError);
  });

  it("times out a hanging request", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    await expect(getHealth(BASE_URL, { timeoutMs: 10 })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  it("propagates an externally supplied AbortSignal", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const promise = getHealth(BASE_URL, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ApiClientError);
  });

  it("never exposes a raw server error body when the error shape itself is unrecognized", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { unexpected: "shape", stack: "at Object.<anonymous> (secret/path.ts:1:1)" },
        500,
      ),
    );
    try {
      await getHealth(BASE_URL);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError);
      const message = (error as ApiClientError).message;
      expect(message).not.toContain("secret/path.ts");
      expect(message).not.toContain("stack");
    }
  });

  it("createDeferredTask: handles the 201 Created response with no runId/eventsPath", async () => {
    const now = new Date().toISOString();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          task: {
            taskId: "task-2",
            projectId: "project-1",
            title: "Planning task",
            description: "",
            priority: "normal",
            status: "backlog",
            dependencyTaskIds: [],
            createdAt: now,
            updatedAt: now,
          },
          eventCount: 0,
          cancellationRequested: false,
          createdAt: now,
        },
        201,
      ),
    );
    const result = await createDeferredTask(BASE_URL, {
      projectId: "project-1",
      title: "Planning task",
    });
    expect(result.task.status).toBe("backlog");
    expect(result.runId).toBeUndefined();
    expect(result.eventsPath).toBeUndefined();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ executionMode: "deferred" });
  });

  it("transitionTask: returns the updated task record on success", async () => {
    const now = new Date().toISOString();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        task: {
          taskId: "task-1",
          projectId: "project-1",
          title: "Test",
          description: "",
          priority: "normal",
          status: "ready",
          dependencyTaskIds: [],
          createdAt: now,
          updatedAt: now,
        },
        eventCount: 0,
        cancellationRequested: false,
        createdAt: now,
      }),
    );
    const result = await transitionTask(BASE_URL, "task-1", "ready");
    expect(result.task.status).toBe("ready");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/tasks/task-1/transition`);
    expect(JSON.parse(init.body as string)).toEqual({ targetStatus: "ready" });
  });

  it("transitionTask: surfaces a 409 invalid-transition error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "INVALID_TASK_TRANSITION", message: "Cannot move to running." } },
        409,
      ),
    );
    await expect(transitionTask(BASE_URL, "task-1", "running")).rejects.toMatchObject({
      code: "INVALID_TASK_TRANSITION",
      statusCode: 409,
    });
  });

  it("assignTask: returns the updated task record on success", async () => {
    const now = new Date().toISOString();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        task: {
          taskId: "task-1",
          projectId: "project-1",
          title: "Test",
          description: "",
          priority: "normal",
          status: "assigned",
          dependencyTaskIds: [],
          createdAt: now,
          updatedAt: now,
        },
        adapterId: "hall.mock-agent",
        agentId: "mock-agent",
        eventCount: 0,
        cancellationRequested: false,
        createdAt: now,
      }),
    );
    const result = await assignTask(BASE_URL, "task-1", { adapterId: "hall.mock-agent" });
    expect(result.task.status).toBe("assigned");
    expect(result.adapterId).toBe("hall.mock-agent");
  });

  it("assignTask: surfaces a 409 adapter-unavailable failure", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "ADAPTER_UNAVAILABLE", message: "Adapter is busy." } }, 409),
    );
    await expect(
      assignTask(BASE_URL, "task-1", { adapterId: "hall.mock-agent" }),
    ).rejects.toMatchObject({ code: "ADAPTER_UNAVAILABLE", statusCode: 409 });
  });

  it("startTask: handles the 202 Accepted response with eventsPath", async () => {
    const now = new Date().toISOString();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          task: {
            taskId: "task-1",
            projectId: "project-1",
            title: "Test",
            description: "",
            priority: "normal",
            status: "assigned",
            dependencyTaskIds: [],
            createdAt: now,
            updatedAt: now,
          },
          runId: "run-1",
          adapterId: "hall.mock-agent",
          agentId: "mock-agent",
          eventCount: 0,
          cancellationRequested: false,
          createdAt: now,
          eventsPath: "/api/v1/tasks/task-1/events",
        },
        202,
      ),
    );
    const result = await startTask(BASE_URL, "task-1");
    expect(result.runId).toBe("run-1");
    expect(result.eventsPath).toBe("/api/v1/tasks/task-1/events");
  });

  it("startTask: surfaces a 409 conflict for a duplicate concurrent start", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "TASK_STATE_CONFLICT", message: "Already started." } }, 409),
    );
    await expect(startTask(BASE_URL, "task-1")).rejects.toMatchObject({
      code: "TASK_STATE_CONFLICT",
      statusCode: 409,
    });
  });

  it("does not include credentials on any request", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: "ok",
        application: "hall-core",
        protocolVersion: "0.1",
        uptimeSeconds: 0,
      }),
    );
    await getHealth(BASE_URL);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("omit");
  });
});
