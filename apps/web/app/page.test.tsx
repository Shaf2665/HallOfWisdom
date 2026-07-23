import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HomePage from "./page";
import * as apiClient from "../lib/api-client";
import type { AdapterSummary, CreateTaskResponse } from "../lib/api-schemas";

vi.mock("../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/api-client")>("../lib/api-client");
  return {
    ...actual,
    getHealth: vi.fn(),
    listAdapters: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    getTask: vi.fn(),
    ensureTaskBoard: vi.fn(),
  };
});

const mockRouter = { push: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/",
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

function makeAdapter(): AdapterSummary {
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
    declaredCapabilities: ["structured.events", "cancellation"],
    assignable: true,
    executionTrust: "simulated",
    capabilityObservations: [],
    limitations: [],
    detectedAt: "2026-07-15T12:00:00.000Z",
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

describe("HomePage (dashboard)", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", InertWebSocket);
    vi.mocked(apiClient.getHealth).mockResolvedValue({
      status: "ok",
      application: "hall-core",
      protocolVersion: "0.1",
      uptimeSeconds: 1,
    });
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the dashboard with its main sections", async () => {
    render(<HomePage />);
    expect(screen.getByRole("heading", { level: 1, name: "Hall of Wisdom" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Create Task" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent Tasks" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Online/)).toBeInTheDocument();
    });
  });

  it("selects the newly created task after a successful submission", async () => {
    vi.mocked(apiClient.createTask).mockResolvedValue(makeCreated());
    const user = userEvent.setup();
    render(<HomePage />);
    await waitFor(() => screen.getByRole("option", { name: "Mock Agent" }));

    await user.type(screen.getByLabelText("Project"), "project-1");
    await user.type(screen.getByLabelText("Title"), "New task");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByRole("heading", { name: "New task" })).toBeInTheDocument();
  });
});
