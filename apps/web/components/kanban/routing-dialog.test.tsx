import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { RoutingAnalysisResponse, TaskRecord } from "../../lib/api-schemas";
import { RoutingDialog } from "./routing-dialog";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, getRoutingAnalysis: vi.fn(), routeAndAssign: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    task: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Fix the bug",
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
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<RoutingAnalysisResponse> = {}): RoutingAnalysisResponse {
  return {
    taskId: "task-1",
    requiredCapabilities: ["structured.events"],
    allowedExecutionTrust: ["simulated"],
    candidates: [
      {
        adapterId: "hall.mock-agent",
        displayName: "Mock Agent",
        availability: "available",
        assignable: true,
        executionTrust: "simulated",
        verifiedCapabilities: ["structured.events"],
        missingCapabilities: [],
        restrictedCapabilities: [],
        trustAllowed: true,
        safeReason:
          "Mock Agent meets every required capability and its execution trust is allowed.",
        rank: 1,
      },
    ],
    recommendedAdapterId: "hall.mock-agent",
    explanation: 'Recommended "Mock Agent": meets every requirement.',
    generatedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("RoutingDialog", () => {
  beforeEach(() => {
    vi.mocked(apiClient.getRoutingAnalysis).mockReset();
    vi.mocked(apiClient.routeAndAssign).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs a read-only analysis on mount and shows the recommended candidate", async () => {
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue(makeAnalysis());
    render(
      <RoutingDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Mock Agent")).toBeInTheDocument();
    });
    expect(apiClient.routeAndAssign).not.toHaveBeenCalled();
  });

  it("closing the dialog never calls route-and-assign", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue(makeAnalysis());
    render(
      <RoutingDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByText("Mock Agent"));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(apiClient.routeAndAssign).not.toHaveBeenCalled();
  });

  it("Escape closes without assigning", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue(makeAnalysis());
    render(
      <RoutingDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByText("Mock Agent"));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(apiClient.routeAndAssign).not.toHaveBeenCalled();
  });

  it("explicit Route and assign calls the API and reports the assigned record", async () => {
    const user = userEvent.setup();
    const onAssigned = vi.fn();
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue(makeAnalysis());
    const assignedRecord = makeRecord({ adapterId: "hall.mock-agent", agentId: "mock-agent" });
    vi.mocked(apiClient.routeAndAssign).mockResolvedValue({
      record: assignedRecord,
      routingExplanation: makeAnalysis().explanation,
      generatedAt: "2026-07-15T12:00:00.000Z",
    });
    render(
      <RoutingDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={onAssigned}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByText("Mock Agent"));
    await user.click(screen.getByRole("button", { name: "Route and assign" }));
    await waitFor(() => {
      expect(apiClient.routeAndAssign).toHaveBeenCalledTimes(1);
      expect(onAssigned).toHaveBeenCalledWith(assignedRecord);
    });
  });

  it("disables Route and assign when no adapter qualifies", async () => {
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue(
      makeAnalysis({
        recommendedAdapterId: undefined,
        explanation: "No adapter currently qualifies.",
      }),
    );
    render(
      <RoutingDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("No adapter currently qualifies.")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Route and assign" })).toBeDisabled();
    expect(apiClient.routeAndAssign).not.toHaveBeenCalled();
  });

  it("switching to the custom profile and unchecking every trust level shows a validation message and disables submit", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue(makeAnalysis());
    render(
      <RoutingDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Requirement profile"), "Custom");
    await user.click(screen.getByLabelText("isolated"));
    expect(
      screen.getAllByText("Select at least one allowed execution trust level.").length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Route and assign" })).toBeDisabled();
  });

  it("has dialog role, aria-modal, and a labelled title", () => {
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue(makeAnalysis());
    render(
      <RoutingDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(/Find suitable agent/);
  });

  it("returns focus to the previously focused element on close", async () => {
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue(makeAnalysis());
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(
      <RoutingDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(opener).not.toHaveFocus();

    unmount();
    expect(opener).toHaveFocus();
    document.body.removeChild(opener);
  });

  it("shows an error message when the analysis request fails, without ever assigning", async () => {
    vi.mocked(apiClient.getRoutingAnalysis).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );
    render(
      <RoutingDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText("Could not analyze candidates.")).toBeInTheDocument();
    expect(apiClient.routeAndAssign).not.toHaveBeenCalled();
  });
});
