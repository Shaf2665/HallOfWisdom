import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetail } from "./task-detail";
import * as apiClient from "../lib/api-client";
import type { CancelTaskResponse, TaskRecord } from "../lib/api-schemas";

vi.mock("../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/api-client")>("../lib/api-client");
  return { ...actual, cancelTask: vi.fn(), ensureTaskBoard: vi.fn() };
});

const mockRouter = { push: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

class InertWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = InertWebSocket.CONNECTING;
  onopen: unknown = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  close(): void {
    this.readyState = InertWebSocket.CLOSED;
  }
  send(): void {
    // never called by this hook
  }
}

const BASE_URL = "http://127.0.0.1:4310";
const WS_BASE_URL = "ws://127.0.0.1:4310";

function makeRecord(
  overrides: Partial<TaskRecord["task"]> = {},
  recordOverrides: Partial<TaskRecord> = {},
): TaskRecord {
  const now = new Date().toISOString();
  return {
    task: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Sample task",
      description: "A task description",
      priority: "normal",
      status: "running",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    runId: "run-1",
    adapterId: "hall.mock-agent",
    agentId: "mock-agent",
    eventCount: 2,
    cancellationRequested: false,
    createdAt: now,
    ...recordOverrides,
  };
}

describe("TaskDetail", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", InertWebSocket);
    vi.mocked(apiClient.cancelTask).mockReset();
    vi.mocked(apiClient.ensureTaskBoard).mockReset();
    mockRouter.push.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("displays the task's core fields", () => {
    render(
      <TaskDetail
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        record={makeRecord()}
        onTaskTerminal={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Sample task" })).toBeInTheDocument();
    expect(screen.getByText("task-1")).toBeInTheDocument();
    expect(screen.getByText("run-1")).toBeInTheDocument();
    expect(screen.getByText("A task description")).toBeInTheDocument();
  });

  it("shows a Cancel button for an active (non-terminal) task", () => {
    render(
      <TaskDetail
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        record={makeRecord({ status: "running" })}
        onTaskTerminal={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel task" })).toBeInTheDocument();
  });

  it("does not offer cancellation for a terminal task", () => {
    render(
      <TaskDetail
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        record={makeRecord({ status: "completed" })}
        onTaskTerminal={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Cancel task" })).not.toBeInTheDocument();
  });

  it("shows a pending state, then 'Cancellation requested' after confirming", async () => {
    let resolveCancel: (value: CancelTaskResponse) => void = () => undefined;
    vi.mocked(apiClient.cancelTask).mockReturnValue(
      new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    const user = userEvent.setup();
    render(
      <TaskDetail
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        record={makeRecord({ status: "running" })}
        onTaskTerminal={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();

    resolveCancel({ taskId: "task-1", cancellationRequested: true, alreadyRequested: false });
    expect(await screen.findByText("Cancellation requested.")).toBeInTheDocument();
  });

  it("shows a safe message on a 409 cancellation conflict", async () => {
    vi.mocked(apiClient.cancelTask).mockRejectedValue(
      new apiClient.ApiClientError("TASK_STATE_CONFLICT", "Task cannot be cancelled.", 409),
    );
    const user = userEvent.setup();
    render(
      <TaskDetail
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        record={makeRecord({ status: "running" })}
        onTaskTerminal={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(screen.getByText("This task can no longer be cancelled.")).toBeInTheDocument();
    });
  });

  it("does not mark the task cancelled locally just from the cancel request being accepted", async () => {
    vi.mocked(apiClient.cancelTask).mockResolvedValue({
      taskId: "task-1",
      cancellationRequested: true,
      alreadyRequested: false,
    });
    const user = userEvent.setup();
    render(
      <TaskDetail
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        record={makeRecord({ status: "running" })}
        onTaskTerminal={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Cancellation requested.");
    // Still shows the original "running" badge — only a real run.cancelled
    // event or a refreshed snapshot may change the displayed status.
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("Open discussion calls ensureTaskBoard and navigates to /boards?boardId=<encoded boardId>", async () => {
    vi.mocked(apiClient.ensureTaskBoard).mockResolvedValueOnce({
      board: {
        boardId: "task:task-1",
        kind: "task",
        title: "Discussion: Sample task",
        taskId: "task-1",
        projectId: "project-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      },
      messagesPath: "/api/v1/boards/task:task-1/messages",
      livePath: "/api/v1/boards/task:task-1/messages/live",
    });
    const user = userEvent.setup();
    render(
      <TaskDetail
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        record={makeRecord({ status: "running" })}
        onTaskTerminal={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open discussion" }));
    await waitFor(() => {
      expect(apiClient.ensureTaskBoard).toHaveBeenCalledWith(BASE_URL, "task-1");
    });
    expect(mockRouter.push).toHaveBeenCalledWith(
      `/boards?boardId=${encodeURIComponent("task:task-1")}`,
    );
  });

  it("Open discussion works for a terminal task and shows a safe error on failure", async () => {
    vi.mocked(apiClient.ensureTaskBoard).mockRejectedValueOnce(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );
    const user = userEvent.setup();
    render(
      <TaskDetail
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        record={makeRecord({ status: "completed" })}
        onTaskTerminal={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: "Open discussion" });
    expect(button).toBeInTheDocument();
    await user.click(button);
    expect(await screen.findByText("Could not reach Hall Core.")).toBeInTheDocument();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});
