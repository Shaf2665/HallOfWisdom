import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { AdapterSummary, RoutingCandidate, TaskRecord } from "../../lib/api-schemas";
import { AssignDialog } from "./assign-dialog";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return {
    ...actual,
    listAdapters: vi.fn(),
    assignTask: vi.fn(),
    getRoutingAnalysis: vi.fn(),
  };
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
    declaredCapabilities: ["structured.events", "cancellation"],
    assignable: true,
    executionTrust: "simulated",
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
      title: "Fix the bug",
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

function makeCandidate(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    adapterId: "hall.mock-agent",
    displayName: "Mock Agent",
    availability: "available",
    assignable: true,
    executionTrust: "simulated",
    verifiedCapabilities: [],
    missingCapabilities: [],
    restrictedCapabilities: [],
    trustAllowed: true,
    safeReason: "Meets every required capability and its execution trust is allowed.",
    ...overrides,
  };
}

describe("AssignDialog", () => {
  beforeEach(() => {
    vi.mocked(apiClient.listAdapters).mockReset();
    vi.mocked(apiClient.assignTask).mockReset();
    vi.mocked(apiClient.getRoutingAnalysis).mockReset();
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

  it("Phase 10.2: shows the trusted-local limitationNotice for an available adapter that carries one", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        makeAdapter({
          adapterId: "hall.codex",
          agentDisplayName: "Codex",
          limitationNotice:
            "Trusted-local mode: Codex sandbox and approval protections are bypassed. Codex runs with the Hall Core user's filesystem permissions.",
        }),
      ],
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
      expect(screen.getByRole("option", { name: /Codex.*see notice below/ })).toBeInTheDocument();
    });
    expect(screen.getByText(/Trusted-local mode: Codex sandbox/)).toBeInTheDocument();
  });

  it(
    "the option-list suffix is generic, safe wording — never asserts 'trusted-local mode' for an " +
      "adapter that isn't in that mode (the full, accurate text lives in the notice below the dropdown)",
    async () => {
      vi.mocked(apiClient.listAdapters).mockResolvedValue({
        adapters: [
          makeAdapter({
            agentDisplayName: "Claude Code",
            limitationNotice:
              "Claude Code is installed and authenticated with a Claude subscription.",
          }),
        ],
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
        expect(
          screen.getByRole("option", { name: /Claude Code.*see notice below/ }),
        ).toBeInTheDocument();
      });
      expect(screen.queryByRole("option", { name: /trusted-local mode/i })).not.toBeInTheDocument();
    },
  );

  it("never shows a limitationNotice for an adapter that does not carry one", async () => {
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
    expect(screen.queryByText(/see notice below/i)).not.toBeInTheDocument();
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

  describe("Requirement-aware assignment (Phase 11.1)", () => {
    it("does not fetch routing-analysis for a task with no requirements", async () => {
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
      expect(apiClient.getRoutingAnalysis).not.toHaveBeenCalled();
    });

    it("shows the task's required capabilities and allowed execution trust", async () => {
      vi.mocked(apiClient.listAdapters).mockResolvedValue({
        adapters: [
          makeAdapter({
            adapterId: "hall.claude",
            agentDisplayName: "Claude Code",
            executionTrust: "isolated",
          }),
        ],
      });
      vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue({
        taskId: "task-1",
        requiredCapabilities: ["project.read", "project.edit"],
        allowedExecutionTrust: ["isolated"],
        candidates: [
          makeCandidate({
            adapterId: "hall.claude",
            displayName: "Claude Code",
            executionTrust: "isolated",
            verifiedCapabilities: ["project.read", "project.edit"],
          }),
        ],
        recommendedAdapterId: "hall.claude",
        explanation: "Recommended.",
        generatedAt: new Date().toISOString(),
      });
      render(
        <AssignDialog
          baseUrl={BASE_URL}
          record={makeRecord({
            requirements: {
              requiredCapabilities: ["project.read", "project.edit"],
              allowedExecutionTrust: ["isolated"],
            },
          })}
          onAssigned={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      expect(await screen.findByText(/project\.read, project\.edit/)).toBeInTheDocument();
      expect(screen.getByText(/^isolated$/)).toBeInTheDocument();
    });

    it("disables an adapter that does not satisfy the task's requirements, with a safe reason", async () => {
      vi.mocked(apiClient.listAdapters).mockResolvedValue({
        adapters: [
          makeAdapter({
            adapterId: "hall.mock-agent",
            agentDisplayName: "Mock Agent",
            executionTrust: "simulated",
          }),
        ],
      });
      vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue({
        taskId: "task-1",
        requiredCapabilities: ["project.read", "project.edit"],
        allowedExecutionTrust: ["isolated"],
        candidates: [
          makeCandidate({
            adapterId: "hall.mock-agent",
            displayName: "Mock Agent",
            executionTrust: "simulated",
            missingCapabilities: ["project.read", "project.edit"],
            trustAllowed: false,
            safeReason:
              "Mock Agent is missing required, verified capabilities: project.read, project.edit.",
          }),
        ],
        recommendedAdapterId: undefined,
        explanation: "No adapter currently qualifies.",
        generatedAt: new Date().toISOString(),
      });
      render(
        <AssignDialog
          baseUrl={BASE_URL}
          record={makeRecord({
            requirements: {
              requiredCapabilities: ["project.read", "project.edit"],
              allowedExecutionTrust: ["isolated"],
            },
          })}
          onAssigned={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      await waitFor(() => {
        expect(screen.getByRole("option", { name: /Mock Agent/ })).toBeDisabled();
      });
      expect(
        await screen.findByText(/No adapter currently satisfies this task's requirements\./),
      ).toBeInTheDocument();
    });

    it("auto-selects the first eligible adapter, skipping an incompatible one", async () => {
      vi.mocked(apiClient.listAdapters).mockResolvedValue({
        adapters: [
          makeAdapter({
            adapterId: "hall.codex",
            agentDisplayName: "Codex",
            executionTrust: "trusted_local",
          }),
          makeAdapter({
            adapterId: "hall.claude",
            agentDisplayName: "Claude Code",
            executionTrust: "isolated",
          }),
        ],
      });
      vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue({
        taskId: "task-1",
        requiredCapabilities: ["project.read", "project.edit"],
        allowedExecutionTrust: ["isolated"],
        candidates: [
          makeCandidate({
            adapterId: "hall.codex",
            displayName: "Codex",
            executionTrust: "trusted_local",
            verifiedCapabilities: ["project.read", "project.edit"],
            trustAllowed: false,
            safeReason: "Codex's execution trust is not in this task's allowed list.",
          }),
          makeCandidate({
            adapterId: "hall.claude",
            displayName: "Claude Code",
            executionTrust: "isolated",
            verifiedCapabilities: ["project.read", "project.edit"],
          }),
        ],
        recommendedAdapterId: "hall.claude",
        explanation: "Recommended.",
        generatedAt: new Date().toISOString(),
      });
      render(
        <AssignDialog
          baseUrl={BASE_URL}
          record={makeRecord({
            requirements: {
              requiredCapabilities: ["project.read", "project.edit"],
              allowedExecutionTrust: ["isolated"],
            },
          })}
          onAssigned={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      await waitFor(() => {
        expect(screen.getByLabelText("Agent")).toHaveValue("hall.claude");
      });
    });

    it("keeps the trusted-local warning visible for a compatible trusted-local adapter", async () => {
      vi.mocked(apiClient.listAdapters).mockResolvedValue({
        adapters: [
          makeAdapter({
            adapterId: "hall.codex",
            agentDisplayName: "Codex",
            executionTrust: "trusted_local",
            limitationNotice:
              "Trusted-local mode: Codex sandbox and approval protections are bypassed. Codex runs with the Hall Core user's filesystem permissions.",
          }),
        ],
      });
      vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue({
        taskId: "task-1",
        requiredCapabilities: ["project.read", "project.edit"],
        allowedExecutionTrust: ["isolated", "trusted_local"],
        candidates: [
          makeCandidate({
            adapterId: "hall.codex",
            displayName: "Codex",
            executionTrust: "trusted_local",
            verifiedCapabilities: ["project.read", "project.edit"],
          }),
        ],
        recommendedAdapterId: "hall.codex",
        explanation: "Recommended.",
        generatedAt: new Date().toISOString(),
      });
      render(
        <AssignDialog
          baseUrl={BASE_URL}
          record={makeRecord({
            requirements: {
              requiredCapabilities: ["project.read", "project.edit"],
              allowedExecutionTrust: ["isolated", "trusted_local"],
            },
          })}
          onAssigned={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      expect(await screen.findByText(/Trusted-local mode: Codex sandbox/)).toBeInTheDocument();
    });

    it("on a server-side ADAPTER_REQUIREMENTS_MISMATCH, keeps the dialog open, shows the safe error, and never moves the task", async () => {
      const user = userEvent.setup();
      const onAssigned = vi.fn();
      vi.mocked(apiClient.listAdapters).mockResolvedValue({
        adapters: [makeAdapter({ agentDisplayName: "Mock Agent" })],
      });
      vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue({
        taskId: "task-1",
        requiredCapabilities: [],
        allowedExecutionTrust: ["simulated"],
        candidates: [makeCandidate()],
        recommendedAdapterId: "hall.mock-agent",
        explanation: "Recommended.",
        generatedAt: new Date().toISOString(),
      });
      vi.mocked(apiClient.assignTask).mockRejectedValue(
        new apiClient.ApiClientError(
          "ADAPTER_REQUIREMENTS_MISMATCH",
          "The selected adapter does not satisfy this task's requirements.",
        ),
      );
      render(
        <AssignDialog
          baseUrl={BASE_URL}
          record={makeRecord({
            requirements: { requiredCapabilities: [], allowedExecutionTrust: ["simulated"] },
          })}
          onAssigned={onAssigned}
          onClose={vi.fn()}
        />,
      );
      await waitFor(() => screen.getByRole("option", { name: "Mock Agent" }));
      await user.click(screen.getByRole("button", { name: "Assign" }));
      expect(
        await screen.findByText("The selected adapter does not satisfy this task's requirements."),
      ).toBeInTheDocument();
      expect(onAssigned).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});
