import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskCreateForm } from "./task-create-form";
import * as apiClient from "../lib/api-client";
import type { AdapterSummary, CreateTaskResponse } from "../lib/api-schemas";

vi.mock("../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/api-client")>("../lib/api-client");
  return { ...actual, listAdapters: vi.fn(), createTask: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeAdapter(overrides: Partial<AdapterSummary> = {}): AdapterSummary {
  return {
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
    ...overrides,
  };
}

function makeCreated(): CreateTaskResponse {
  const now = new Date().toISOString();
  return {
    task: {
      taskId: "task-1",
      projectId: "project-1",
      title: "New task",
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
  };
}

describe("TaskCreateForm", () => {
  beforeEach(() => {
    vi.mocked(apiClient.listAdapters).mockReset();
    vi.mocked(apiClient.createTask).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads adapter options and selects the first available one", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [makeAdapter({ adapterId: "hall.a", agentDisplayName: "Agent A" })],
    });
    render(<TaskCreateForm baseUrl={BASE_URL} onCreated={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Agent A" })).toBeInTheDocument();
    });
  });

  it("disables an unavailable adapter option", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        makeAdapter({
          adapterId: "hall.busy",
          agentDisplayName: "Busy Agent",
          availability: "busy",
        }),
      ],
    });
    render(<TaskCreateForm baseUrl={BASE_URL} onCreated={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Busy Agent/ })).toBeDisabled();
    });
  });

  it("shows field-level errors for empty required fields on submit", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    const user = userEvent.setup();
    render(<TaskCreateForm baseUrl={BASE_URL} onCreated={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: "Submit" }));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Project ID is required.")).toBeInTheDocument();
    expect(screen.getByText("Title is required.")).toBeInTheDocument();
    expect(apiClient.createTask).not.toHaveBeenCalled();
  });

  it("prevents a duplicate submit while a request is pending", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    let resolveCreate: (value: CreateTaskResponse) => void = () => undefined;
    vi.mocked(apiClient.createTask).mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<TaskCreateForm baseUrl={BASE_URL} onCreated={vi.fn()} />);
    await waitFor(() => screen.getByRole("option", { name: "Mock Agent" }));

    await user.type(screen.getByLabelText("Project"), "project-1");
    await user.type(screen.getByLabelText("Title"), "Task title");
    const submitButton = screen.getByRole("button", { name: "Submit" });
    await user.click(submitButton);
    await user.click(submitButton);

    expect(apiClient.createTask).toHaveBeenCalledTimes(1);
    resolveCreate(makeCreated());
  });

  it("on success, calls onCreated with the new task", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    vi.mocked(apiClient.createTask).mockResolvedValue(makeCreated());
    const onCreated = vi.fn<(task: CreateTaskResponse) => void>();
    const user = userEvent.setup();
    render(<TaskCreateForm baseUrl={BASE_URL} onCreated={onCreated} />);
    await waitFor(() => screen.getByRole("option", { name: "Mock Agent" }));

    await user.type(screen.getByLabelText("Project"), "project-1");
    await user.type(screen.getByLabelText("Title"), "Task title");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
    expect(onCreated.mock.calls[0]?.[0].eventsPath).toBe("/api/v1/tasks/task-1/events");
  });

  it("on failure, preserves the entered form values and shows a safe error", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    vi.mocked(apiClient.createTask).mockRejectedValue(
      new apiClient.ApiClientError("SERVER_ERROR", "Task could not be created."),
    );
    const user = userEvent.setup();
    render(<TaskCreateForm baseUrl={BASE_URL} onCreated={vi.fn()} />);
    await waitFor(() => screen.getByRole("option", { name: "Mock Agent" }));

    await user.type(screen.getByLabelText("Project"), "project-1");
    await user.type(screen.getByLabelText("Title"), "Task title");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Task could not be created.")).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toHaveValue("project-1");
    expect(screen.getByLabelText("Title")).toHaveValue("Task title");
    expect(screen.getByRole("button", { name: "Submit" })).not.toBeDisabled();
  });

  it("rejects an absolute working directory before submitting", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    const user = userEvent.setup();
    render(<TaskCreateForm baseUrl={BASE_URL} onCreated={vi.fn()} />);
    await waitFor(() => screen.getByRole("option", { name: "Mock Agent" }));

    await user.type(screen.getByLabelText("Project"), "project-1");
    await user.type(screen.getByLabelText("Title"), "Task title");
    await user.type(screen.getByLabelText(/Working directory/), "C:\\absolute\\path");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(
      await screen.findByText("Working directory must be relative, not absolute."),
    ).toBeInTheDocument();
    expect(apiClient.createTask).not.toHaveBeenCalled();
  });

  it("shows a visible, announced error for an over-long description and does not submit", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    const user = userEvent.setup();
    render(<TaskCreateForm baseUrl={BASE_URL} onCreated={vi.fn()} />);
    await waitFor(() => screen.getByRole("option", { name: "Mock Agent" }));

    await user.type(screen.getByLabelText("Project"), "project-1");
    await user.type(screen.getByLabelText("Title"), "Task title");
    const description = screen.getByLabelText(/Description/);
    // userEvent.type is too slow for 20001 characters; set the value directly
    // and fire the same change event the component listens for.
    await user.click(description);
    fireEvent.change(description, { target: { value: "x".repeat(20001) } });
    await user.click(screen.getByRole("button", { name: "Submit" }));

    const error = await screen.findByText("Description must not exceed 20000 characters.");
    expect(error).toBeInTheDocument();
    expect(error).toHaveAttribute("role", "alert");
    expect(description).toHaveAttribute("aria-invalid", "true");
    expect(apiClient.createTask).not.toHaveBeenCalled();
  });
});
