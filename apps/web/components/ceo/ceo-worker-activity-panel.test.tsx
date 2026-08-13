import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type {
  AdapterSummary,
  CeoDelegationLink,
  CeoPlanStepAttempt,
  CeoPlanStepExecution,
  CeoPlanVersion,
} from "../../lib/api-schemas";
import * as useTaskEventsModule from "../../hooks/use-task-events";
import { CeoWorkerActivityPanel } from "./ceo-worker-activity-panel";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, listAdapters: vi.fn() };
});

vi.mock("../../hooks/use-task-events", async () => {
  const actual =
    await vi.importActual<typeof import("../../hooks/use-task-events")>(
      "../../hooks/use-task-events",
    );
  return { ...actual, useTaskEvents: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";
const WS_BASE_URL = "ws://127.0.0.1:4310";
const PLAN_ID = "plan-1";
const STEP_ID_1 = "step-1";
const STEP_ID_2 = "step-2";
const CHILD_TASK_ID_1 = "task-child-1";
const CHILD_TASK_ID_2 = "task-child-2";

function makeAdapter(overrides: Partial<AdapterSummary> = {}): AdapterSummary {
  return {
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    adapterVersion: "1.0.0",
    agentId: "claude-code",
    agentDisplayName: "Claude Code",
    integrationLevel: "native",
    supportedOperatingSystems: ["windows"],
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: true,
      toolEvents: true,
      fileEditing: true,
      shellExecution: true,
      subagents: false,
      mcp: false,
      acp: false,
    },
    installed: true,
    availability: "available",
    declaredCapabilities: [],
    assignable: true,
    executionTrust: "trusted_local",
    capabilityObservations: [],
    limitations: [],
    detectedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function makeVersion(): CeoPlanVersion {
  return {
    planId: PLAN_ID,
    version: 1,
    objective: "Ship the thing.",
    summary: "Summary.",
    assumptions: [],
    constraints: [],
    steps: [
      {
        id: STEP_ID_1,
        position: 0,
        title: "Write the code",
        objective: "Implement the feature",
        boundedInstructions: "Do it well",
        acceptanceCriteria: [],
        dependencies: [],
        routingSummary: "route",
      },
      {
        id: STEP_ID_2,
        position: 1,
        title: "Review the code",
        objective: "Check the work",
        boundedInstructions: "Do it well",
        acceptanceCriteria: [],
        dependencies: [],
        routingSummary: "route",
      },
    ],
    createdAt: "2026-07-15T12:00:00.000Z",
    createdBy: "ceo_planner",
    contentHash: "a".repeat(64),
  };
}

function makeLinks(): readonly CeoDelegationLink[] {
  return [
    {
      planId: PLAN_ID,
      planVersion: 1,
      stepId: STEP_ID_1,
      childTaskId: CHILD_TASK_ID_1,
      adapterId: "hall.claude-code",
      delegatedAt: "2026-07-15T12:00:00.000Z",
    },
    {
      planId: PLAN_ID,
      planVersion: 1,
      stepId: STEP_ID_2,
      childTaskId: CHILD_TASK_ID_2,
      adapterId: "hall.codex",
      delegatedAt: "2026-07-15T12:00:00.000Z",
    },
  ];
}

function makeStepExecution(overrides: Partial<CeoPlanStepExecution> = {}): CeoPlanStepExecution {
  return {
    planRunId: "run-1",
    planStepId: STEP_ID_1,
    childTaskId: CHILD_TASK_ID_1,
    status: "running",
    attemptCount: 1,
    dependencySummary: {
      totalDependencies: 0,
      completedDependencies: 0,
      failedDependencies: 0,
      cancelledDependencies: 0,
    },
    readinessReason: "ready",
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<CeoPlanStepAttempt> = {}): CeoPlanStepAttempt {
  return {
    id: "attempt-1",
    planRunId: "run-1",
    planStepId: STEP_ID_1,
    childTaskId: CHILD_TASK_ID_1,
    attemptNumber: 1,
    status: "running",
    triggerReason: "execution_started",
    schedulerSignalId: "signal-1",
    createdAt: "2026-07-15T12:00:00.000Z",
    leaseGeneration: 0,
    ...overrides,
  };
}

function renderPanel(props: {
  readonly stepExecutions: readonly CeoPlanStepExecution[];
  readonly attempts?: readonly CeoPlanStepAttempt[];
}): void {
  render(
    <CeoWorkerActivityPanel
      baseUrl={BASE_URL}
      wsBaseUrl={WS_BASE_URL}
      version={makeVersion()}
      links={makeLinks()}
      stepExecutions={props.stepExecutions}
      attempts={props.attempts ?? []}
    />,
  );
}

const IDLE_TASK_EVENTS_RESULT: ReturnType<typeof useTaskEventsModule.useTaskEvents> = {
  connectionState: "idle",
  events: [],
  lastContiguousSequence: -1,
  lastError: null,
  reconnectAttempt: 0,
  terminalEventReceived: false,
  reconnect: () => undefined,
};

describe("CeoWorkerActivityPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("projects the CEO -> worker hierarchy: one card per delegated step, with status and adapter badge", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [makeAdapter(), makeAdapter({ adapterId: "hall.codex", displayName: "Codex" })],
    });
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue(IDLE_TASK_EVENTS_RESULT);

    renderPanel({
      stepExecutions: [
        makeStepExecution({ planStepId: STEP_ID_1, status: "running" }),
        makeStepExecution({ planStepId: STEP_ID_2, childTaskId: CHILD_TASK_ID_2, status: "failed" }),
      ],
    });

    expect(screen.getByText("Write the code")).toBeInTheDocument();
    expect(screen.getByText("Review the code")).toBeInTheDocument();
    // "Claude Code"/"Codex" each appear twice — once as a worker badge, once
    // as an adapter-filter <option> — so this asserts on count, not identity.
    await waitFor(() => {
      expect(screen.getAllByText("Claude Code")).toHaveLength(2);
      expect(screen.getAllByText("Codex")).toHaveLength(2);
    });
  });

  it("shows the finished-of-total worker count and updates it as statuses change", () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [] });
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue(IDLE_TASK_EVENTS_RESULT);

    const { rerender } = render(
      <CeoWorkerActivityPanel
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        version={makeVersion()}
        links={makeLinks()}
        stepExecutions={[
          makeStepExecution({ planStepId: STEP_ID_1, status: "running" }),
          makeStepExecution({ planStepId: STEP_ID_2, childTaskId: CHILD_TASK_ID_2, status: "running" }),
        ]}
        attempts={[]}
      />,
    );
    expect(screen.getByText(/0 of 2 workers finished/)).toBeInTheDocument();

    rerender(
      <CeoWorkerActivityPanel
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        version={makeVersion()}
        links={makeLinks()}
        stepExecutions={[
          makeStepExecution({ planStepId: STEP_ID_1, status: "completed" }),
          makeStepExecution({ planStepId: STEP_ID_2, childTaskId: CHILD_TASK_ID_2, status: "running" }),
        ]}
        attempts={[]}
      />,
    );
    expect(screen.getByText(/1 of 2 workers finished/)).toBeInTheDocument();
  });

  it("passes null (not the real task id) to useTaskEvents while a worker card is collapsed, and the real id once expanded", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [] });
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue(IDLE_TASK_EVENTS_RESULT);

    renderPanel({ stepExecutions: [makeStepExecution({ status: "running" })] });

    await waitFor(() => {
      expect(useTaskEventsModule.useTaskEvents).toHaveBeenCalledWith(null, WS_BASE_URL);
    });

    await userEvent.click(screen.getByText("Write the code"));

    await waitFor(() => {
      expect(useTaskEventsModule.useTaskEvents).toHaveBeenCalledWith(CHILD_TASK_ID_1, WS_BASE_URL);
    });
  });

  it("renders live events for an expanded worker via the shared TaskEventTimeline", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [] });
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue({
      ...IDLE_TASK_EVENTS_RESULT,
      connectionState: "connected",
      events: [
        {
          protocolVersion: "0.1",
          eventId: "event-0",
          runId: "run-1",
          taskId: CHILD_TASK_ID_1,
          agentId: "agent-1",
          timestamp: "2026-07-15T12:00:00.000Z",
          sequence: 0,
          type: "message.delta",
          payload: { text: "working on it" },
        },
      ],
    });

    renderPanel({ stepExecutions: [makeStepExecution({ status: "running" })] });
    await userEvent.click(screen.getByText("Write the code"));

    expect(await screen.findByText("working on it")).toBeInTheDocument();
  });

  it("filters by status", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [] });
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue(IDLE_TASK_EVENTS_RESULT);

    renderPanel({
      stepExecutions: [
        makeStepExecution({ planStepId: STEP_ID_1, status: "running" }),
        makeStepExecution({ planStepId: STEP_ID_2, childTaskId: CHILD_TASK_ID_2, status: "failed" }),
      ],
    });

    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "failed");

    expect(screen.queryByText("Write the code")).not.toBeInTheDocument();
    expect(screen.getByText("Review the code")).toBeInTheDocument();
  });

  it("filters by search across title/objective", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [] });
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue(IDLE_TASK_EVENTS_RESULT);

    renderPanel({
      stepExecutions: [
        makeStepExecution({ planStepId: STEP_ID_1, status: "running" }),
        makeStepExecution({ planStepId: STEP_ID_2, childTaskId: CHILD_TASK_ID_2, status: "running" }),
      ],
    });

    await userEvent.type(screen.getByLabelText("Search workers"), "review");

    expect(screen.queryByText("Write the code")).not.toBeInTheDocument();
    expect(screen.getByText("Review the code")).toBeInTheDocument();
  });

  it("highlights a failed worker's error summary", () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [] });
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue(IDLE_TASK_EVENTS_RESULT);

    renderPanel({
      stepExecutions: [
        makeStepExecution({ status: "failed", lastFailureCode: "ADAPTER_ERROR" }),
      ],
      attempts: [makeAttempt({ status: "failed", safeFailureSummary: "The adapter crashed." })],
    });

    const error = screen.getByText("The adapter crashed.");
    expect(error).toHaveClass("text-red-600");
  });

  it("falls back to omitting the adapter badge entirely when listAdapters rejects, without throwing", async () => {
    vi.mocked(apiClient.listAdapters).mockRejectedValue(new Error("network error"));
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue(IDLE_TASK_EVENTS_RESULT);

    renderPanel({ stepExecutions: [makeStepExecution({ status: "running" })] });

    await waitFor(() => {
      expect(apiClient.listAdapters).toHaveBeenCalled();
    });
    expect(screen.getByText("Write the code")).toBeInTheDocument();
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
  });

  it("falls back to omitting the adapter badge when listAdapters is unmocked (returns undefined), without throwing", () => {
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue(IDLE_TASK_EVENTS_RESULT);

    renderPanel({ stepExecutions: [makeStepExecution({ status: "running" })] });

    expect(screen.getByText("Write the code")).toBeInTheDocument();
  });

  it("renders a worker with no adapter link at all without a badge", () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [] });
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue(IDLE_TASK_EVENTS_RESULT);

    renderPanel({
      stepExecutions: [
        makeStepExecution({ planStepId: "step-unlinked", childTaskId: "task-unlinked", status: "queued" }),
      ],
    });

    expect(screen.getByText("step-unlinked")).toBeInTheDocument();
  });

  it("shows a safe tool.completed summary with no raw output leaking through when an adapter never provides output", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [] });
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue({
      ...IDLE_TASK_EVENTS_RESULT,
      connectionState: "connected",
      events: [
        {
          protocolVersion: "0.1",
          eventId: "event-0",
          runId: "run-1",
          taskId: CHILD_TASK_ID_1,
          agentId: "agent-1",
          timestamp: "2026-07-15T12:00:00.000Z",
          sequence: 0,
          type: "tool.completed",
          payload: { toolCallId: "call-1", toolName: "project_read", success: true },
        },
      ],
    });

    renderPanel({ stepExecutions: [makeStepExecution({ status: "running" })] });
    await userEvent.click(screen.getByText("Write the code"));

    expect(await screen.findByText("Completed tool: project_read")).toBeInTheDocument();
  });

  it("does not regress: an empty step-execution list renders the panel with zero workers, no crash", () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [] });
    vi.mocked(useTaskEventsModule.useTaskEvents).mockReturnValue(IDLE_TASK_EVENTS_RESULT);

    renderPanel({ stepExecutions: [] });

    expect(screen.getByText(/0 of 0 workers finished/)).toBeInTheDocument();
  });
});
