import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { AdapterSummary, AgentComparisonRecord, TaskRecord } from "../../lib/api-schemas";
import { CompareAgentsDialog } from "./compare-agents-dialog";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, listAdapters: vi.fn(), createComparison: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeAdapter(overrides: Partial<AdapterSummary> = {}): AdapterSummary {
  return {
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    adapterVersion: "0.1.0",
    agentId: "claude-code",
    agentDisplayName: "Claude Code",
    integrationLevel: "native",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
      toolEvents: true,
      fileEditing: true,
      shellExecution: false,
      subagents: false,
      mcp: false,
      acp: false,
    },
    installed: true,
    availability: "available",
    declaredCapabilities: ["project.read", "project.edit", "structured.events", "cancellation"],
    assignable: true,
    executionTrust: "isolated",
    capabilityObservations: [],
    limitations: [],
    detectedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function makeRecord(overrides: Partial<TaskRecord["task"]> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    task: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Add a health check endpoint",
      description: "",
      priority: "normal",
      status: "ready",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    eventCount: 0,
    cancellationRequested: false,
    createdAt: now,
  };
}

function makeComparisonResponse(): AgentComparisonRecord {
  const now = new Date().toISOString();
  return {
    comparisonId: "comparison-1",
    sourceTaskId: "task-1",
    title: "Add a health check endpoint",
    description: "",
    priority: "normal",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    candidates: [
      {
        candidateId: "candidate-a",
        adapterId: "hall.claude-code",
        displayName: "Claude Code",
        status: "pending",
        cancellationRequested: false,
        createdAt: now,
        eventCount: 0,
      },
      {
        candidateId: "candidate-b",
        adapterId: "hall.codex",
        displayName: "Codex",
        status: "pending",
        cancellationRequested: false,
        createdAt: now,
        eventCount: 0,
      },
    ],
    cleanupStatus: "not_started",
  };
}

describe("CompareAgentsDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads adapters, defaults to two distinct available ones, and creates a comparison on submit", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        makeAdapter({ adapterId: "hall.claude-code", agentDisplayName: "Claude Code" }),
        makeAdapter({ adapterId: "hall.codex", agentDisplayName: "Codex" }),
      ],
    });
    const comparisonResponse = makeComparisonResponse();
    vi.mocked(apiClient.createComparison).mockResolvedValue(comparisonResponse);
    const onCreated = vi.fn();
    const onClose = vi.fn();

    render(
      <CompareAgentsDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onCreated={onCreated}
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "First candidate" })).toHaveValue(
        "hall.claude-code",
      );
    });
    expect(screen.getByRole("combobox", { name: "Second candidate" })).toHaveValue("hall.codex");

    await user.click(screen.getByRole("button", { name: "Compare" }));

    await waitFor(() => {
      expect(apiClient.createComparison).toHaveBeenCalledWith(BASE_URL, {
        sourceTaskId: "task-1",
        candidateAdapterIds: ["hall.claude-code", "hall.codex"],
      });
    });
    expect(onCreated).toHaveBeenCalledWith(comparisonResponse);
  });

  it("never allows selecting the same adapter for both candidates", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        makeAdapter({ adapterId: "hall.claude-code" }),
        makeAdapter({ adapterId: "hall.codex" }),
      ],
    });

    render(
      <CompareAgentsDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onCreated={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "First candidate" })).toHaveValue(
        "hall.claude-code",
      );
    });

    const secondSelect = screen.getByRole("combobox", { name: "Second candidate" });
    const claudeOptionInSecond = Array.from(secondSelect.querySelectorAll("option")).find(
      (option) => option.value === "hall.claude-code",
    );
    expect(claudeOptionInSecond?.disabled).toBe(true);

    await user.selectOptions(secondSelect, "hall.codex");
    expect(screen.getByRole("button", { name: "Compare" })).not.toBeDisabled();
  });

  it("shows a safe error message and never submits when creation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        makeAdapter({ adapterId: "hall.claude-code" }),
        makeAdapter({ adapterId: "hall.codex" }),
      ],
    });
    vi.mocked(apiClient.createComparison).mockRejectedValue(
      new apiClient.ApiClientError(
        "COMPARISON_SOURCE_TASK_NOT_FOUND",
        'No task found with taskId "task-1" to compare against.',
      ),
    );
    const onCreated = vi.fn();

    render(
      <CompareAgentsDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onCreated={onCreated}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "First candidate" })).toHaveValue(
        "hall.claude-code",
      );
    });
    await user.click(screen.getByRole("button", { name: "Compare" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        'No task found with taskId "task-1" to compare against.',
      );
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("calls onClose without creating anything when Cancel is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [] });
    const onClose = vi.fn();

    render(
      <CompareAgentsDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onCreated={vi.fn()}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(apiClient.createComparison).not.toHaveBeenCalled();
  });
});
