import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { AdapterSummary, TaskRecord } from "../../lib/api-schemas";
import { AssignDialog } from "./assign-dialog";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, listAdapters: vi.fn(), assignTask: vi.fn() };
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

function makeRecord(): TaskRecord {
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
  };
}

describe("AssignDialog", () => {
  beforeEach(() => {
    vi.mocked(apiClient.listAdapters).mockReset();
    vi.mocked(apiClient.assignTask).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads adapters and selects the first available one", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [makeAdapter({ agentDisplayName: "Agent A" })],
    });
    render(
      <AssignDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Agent A" })).toBeInTheDocument();
    });
  });

  it("disables an unavailable adapter with safe status text", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [makeAdapter({ agentDisplayName: "Busy Agent", availability: "busy" })],
    });
    render(
      <AssignDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Busy Agent/ })).toBeDisabled();
    });
  });

  it("has dialog role, aria-modal, and a labelled title", () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    render(
      <AssignDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(/Assign an agent/);
  });

  it("Escape closes the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    render(
      <AssignDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={onClose}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the previously focused element on close", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.appendChild(opener);
    opener.focus();
    expect(opener).toHaveFocus();

    const { unmount } = render(
      <AssignDialog
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

  it("Tab from the last focusable element wraps to the first (focus trap)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    render(
      <AssignDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const assignButton = await screen.findByRole("button", { name: "Assign" });
    assignButton.focus();
    await user.tab();
    // Wrapped back to the first focusable element in the dialog (the adapter select).
    expect(screen.getByLabelText("Agent")).toHaveFocus();
  });

  it("submits and calls onAssigned on success", async () => {
    const user = userEvent.setup();
    const onAssigned = vi.fn();
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    const now = new Date().toISOString();
    vi.mocked(apiClient.assignTask).mockResolvedValue({
      task: { ...makeRecord().task, status: "assigned", updatedAt: now },
      adapterId: "hall.mock-agent",
      agentId: "mock-agent",
      eventCount: 0,
      cancellationRequested: false,
      createdAt: now,
    });
    render(
      <AssignDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={onAssigned}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByRole("option", { name: "Mock Agent" }));
    await user.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => {
      expect(onAssigned).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects an absolute working directory before submitting", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    render(
      <AssignDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByRole("option", { name: "Mock Agent" }));
    await user.type(screen.getByLabelText(/Working directory/), "C:\\absolute\\path");
    await user.click(screen.getByRole("button", { name: "Assign" }));
    expect(
      await screen.findByText("Working directory must be relative, not absolute."),
    ).toBeInTheDocument();
    expect(apiClient.assignTask).not.toHaveBeenCalled();
  });

  it("on failure, preserves entered values and shows a safe error", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    vi.mocked(apiClient.assignTask).mockRejectedValue(
      new apiClient.ApiClientError("ADAPTER_UNAVAILABLE", "Adapter is busy."),
    );
    render(
      <AssignDialog
        baseUrl={BASE_URL}
        record={makeRecord()}
        onAssigned={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => screen.getByRole("option", { name: "Mock Agent" }));
    await user.type(screen.getByLabelText(/Working directory/), "src");
    await user.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByText("Adapter is busy.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Working directory/)).toHaveValue("src");
  });
});
