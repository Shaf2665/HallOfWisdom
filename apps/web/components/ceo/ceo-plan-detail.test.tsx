import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type {
  CeoPlan,
  CeoPlanVersion,
  GetCeoPlanResponse,
  RoutingAnalysisResponse,
  TaskRecord,
} from "../../lib/api-schemas";
import { CeoPlanDetail } from "./ceo-plan-detail";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return {
    ...actual,
    getCeoPlan: vi.fn(),
    getCeoPlanVersion: vi.fn(),
    listCeoApprovals: vi.fn(),
    submitCeoPlan: vi.fn(),
    createCeoPlanVersion: vi.fn(),
    deleteCeoPlan: vi.fn(),
    getTask: vi.fn(),
    getRoutingAnalysis: vi.fn(),
    listAdapters: vi.fn(),
  };
});

vi.mock("../../hooks/use-ceo-plan-events", () => ({
  useCeoPlanEvents: () => ({ connectionState: "idle", events: [], lastSequence: -1 }),
}));

const BASE_URL = "http://127.0.0.1:4310";
const WS_BASE_URL = "ws://127.0.0.1:4310";
const PLAN_ID = "plan-1";
const PARENT_TASK_ID = "task-1";

function makePlan(overrides: Partial<CeoPlan> = {}): CeoPlan {
  return {
    id: PLAN_ID,
    parentTaskId: PARENT_TASK_ID,
    status: "rejected",
    activeVersion: 1,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    createdBy: "ceo_planner",
    ...overrides,
  };
}

function makeVersion(overrides: Partial<CeoPlanVersion> = {}): CeoPlanVersion {
  return {
    planId: PLAN_ID,
    version: 1,
    objective: "Fix the bug end to end.",
    summary: "Original summary",
    assumptions: [],
    constraints: [],
    steps: [
      {
        id: "step-1",
        position: 0,
        title: "Investigate",
        objective: "Understand the current behavior.",
        boundedInstructions: "Read the relevant files.",
        acceptanceCriteria: ["A summary of findings is written."],
        dependencies: [],
        routingSummary: "No adapter recommended.",
      },
    ],
    createdAt: "2026-07-15T12:00:00.000Z",
    createdBy: "ceo_planner",
    contentHash: "a".repeat(64),
    ...overrides,
  };
}

function makeGetPlanResponse(
  overrides: Partial<GetCeoPlanResponse> & { readonly plan: CeoPlan },
): GetCeoPlanResponse {
  return {
    progress: {
      totalSteps: 1,
      completed: 0,
      running: 0,
      failed: 0,
      cancelled: 0,
      blocked: 0,
      notStarted: 1,
      steps: [{ stepId: "step-1", status: "waiting_for_dependencies" }],
    },
    links: [],
    mutationToken: "tok-1",
    ...overrides,
  };
}

function makeTaskRecord(overrides: Partial<TaskRecord["task"]> = {}): TaskRecord {
  return {
    task: {
      taskId: PARENT_TASK_ID,
      projectId: "project-1",
      title: "Add authentication system",
      description: "",
      priority: "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: "2026-07-15T12:00:00.000Z",
      updatedAt: "2026-07-15T12:00:00.000Z",
      ...overrides,
    },
    adapterId: undefined,
    agentId: undefined,
    runId: undefined,
    eventCount: 0,
    cancellationRequested: false,
    createdAt: "2026-07-15T12:00:00.000Z",
  };
}

describe("CeoPlanDetail", () => {
  beforeEach(() => {
    navigation.push.mockReset();
    vi.mocked(apiClient.getRoutingAnalysis).mockReset();
    vi.mocked(apiClient.deleteCeoPlan).mockReset();
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [] });
    vi.mocked(apiClient.getTask).mockResolvedValue(makeTaskRecord());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a rejected plan offers Edit plan but not Submit for approval; editing it into a new draft version makes Submit for approval appear and work", async () => {
    const rejectedPlan = makePlan({ status: "rejected", activeVersion: 1 });
    const draftPlan = makePlan({ status: "draft", activeVersion: 2 });
    const version1 = makeVersion({ version: 1 });
    const version2 = makeVersion({ version: 2, summary: "Revised summary" });

    vi.mocked(apiClient.getCeoPlan)
      .mockResolvedValueOnce(makeGetPlanResponse({ plan: rejectedPlan, mutationToken: "tok-1" }))
      .mockResolvedValue(makeGetPlanResponse({ plan: draftPlan, mutationToken: "tok-2" }));
    vi.mocked(apiClient.getCeoPlanVersion).mockImplementation((_baseUrl, _planId, version) =>
      Promise.resolve(version === 1 ? version1 : version2),
    );
    vi.mocked(apiClient.listCeoApprovals).mockResolvedValue({ approvals: [] });
    vi.mocked(apiClient.createCeoPlanVersion).mockResolvedValue({
      plan: draftPlan,
      version: version2,
    });
    vi.mocked(apiClient.submitCeoPlan).mockResolvedValue(draftPlan);

    render(<CeoPlanDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} planId={PLAN_ID} />);

    expect(
      await screen.findByRole("heading", { name: "CEO Plan — Add authentication system" }),
    ).toBeInTheDocument();
    expect(apiClient.getTask).toHaveBeenCalledWith(BASE_URL, PARENT_TASK_ID);
    expect(await screen.findByRole("button", { name: "Edit plan…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit for approval" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit plan…" }));
    await userEvent.click(await screen.findByRole("button", { name: "Save as new version" }));

    await waitFor(() => {
      expect(apiClient.createCeoPlanVersion).toHaveBeenCalledWith(
        BASE_URL,
        PLAN_ID,
        expect.objectContaining({ expectedMutationToken: "tok-1" }),
      );
    });

    const submitButton = await screen.findByRole("button", { name: "Submit for approval" });
    expect(screen.queryByRole("button", { name: "Edit plan…" })).toBeInTheDocument();

    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(apiClient.submitCeoPlan).toHaveBeenCalledWith(BASE_URL, PLAN_ID, "tok-2");
    });
  });

  it("saves inline agent choices as a new version with every other step field preserved", async () => {
    const draftPlan = makePlan({ status: "draft", activeVersion: 1 });
    const revisedPlan = makePlan({ status: "draft", activeVersion: 2 });
    const baseStep = makeVersion().steps[0];
    if (baseStep === undefined) throw new Error("Expected the fixture to include one step.");
    const version1 = makeVersion({
      steps: [
        {
          ...baseStep,
          requirements: {
            requiredCapabilities: ["project.read"],
            allowedExecutionTrust: ["isolated"],
          },
          recommendedAdapterId: "hall.claude-code",
        },
      ],
    });
    const version2 = makeVersion({ version: 2, steps: version1.steps });
    const analysis: RoutingAnalysisResponse = {
      taskId: PARENT_TASK_ID,
      requiredCapabilities: ["project.read"],
      allowedExecutionTrust: ["isolated"],
      candidates: [
        {
          adapterId: "hall.claude-code",
          displayName: "Claude Code",
          availability: "available",
          assignable: true,
          executionTrust: "isolated",
          verifiedCapabilities: ["project.read"],
          missingCapabilities: [],
          restrictedCapabilities: [],
          trustAllowed: true,
          safeReason: "Available.",
          rank: 1,
        },
        {
          adapterId: "hall.mock-agent",
          displayName: "Mock Agent",
          availability: "available",
          assignable: true,
          executionTrust: "isolated",
          verifiedCapabilities: ["project.read"],
          missingCapabilities: [],
          restrictedCapabilities: [],
          trustAllowed: true,
          safeReason: "Available.",
          rank: 2,
        },
        {
          adapterId: "hall.unavailable-agent",
          displayName: "Unavailable Agent",
          availability: "unavailable",
          assignable: false,
          executionTrust: "unavailable",
          verifiedCapabilities: [],
          missingCapabilities: ["project.read"],
          restrictedCapabilities: [],
          trustAllowed: false,
          safeReason: "Unavailable.",
        },
      ],
      recommendedAdapterId: "hall.claude-code",
      explanation: "Claude Code is recommended.",
      generatedAt: "2026-07-15T12:00:00.000Z",
    };

    vi.mocked(apiClient.getCeoPlan)
      .mockResolvedValueOnce(makeGetPlanResponse({ plan: draftPlan, mutationToken: "tok-1" }))
      .mockResolvedValue(makeGetPlanResponse({ plan: revisedPlan, mutationToken: "tok-2" }));
    vi.mocked(apiClient.getCeoPlanVersion).mockImplementation((_baseUrl, _planId, version) =>
      Promise.resolve(version === 1 ? version1 : version2),
    );
    vi.mocked(apiClient.listCeoApprovals).mockResolvedValue({ approvals: [] });
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue(analysis);
    vi.mocked(apiClient.createCeoPlanVersion).mockResolvedValue({
      plan: revisedPlan,
      version: version2,
    });

    render(<CeoPlanDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} planId={PLAN_ID} />);

    const selector = await screen.findByRole("combobox", { name: "Agent for Investigate" });
    expect(
      screen.getByRole("option", { name: "Claude Code (hall.claude-code)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Unavailable Agent (hall.unavailable-agent)" }),
    ).toBeNull();

    await userEvent.selectOptions(selector, "hall.mock-agent");
    await userEvent.click(screen.getByRole("button", { name: "Save agent choices" }));

    await waitFor(() => {
      expect(apiClient.createCeoPlanVersion).toHaveBeenCalledWith(BASE_URL, PLAN_ID, {
        expectedMutationToken: "tok-1",
        objective: version1.objective,
        summary: version1.summary,
        assumptions: version1.assumptions,
        constraints: version1.constraints,
        steps: [
          {
            id: "step-1",
            position: 0,
            title: "Investigate",
            objective: "Understand the current behavior.",
            boundedInstructions: "Read the relevant files.",
            acceptanceCriteria: ["A summary of findings is written."],
            dependencies: [],
            requirements: {
              requiredCapabilities: ["project.read"],
              allowedExecutionTrust: ["isolated"],
            },
            selectedAdapterId: "hall.mock-agent",
          },
        ],
      });
    });

    expect(
      await screen.findByText("New plan version saved with updated agent choices."),
    ).toBeInTheDocument();
    expect(screen.getByText("Active version").parentElement).toHaveTextContent("2");
  });

  it("falls back to the parent task ID when its title cannot be loaded", async () => {
    const plan = makePlan();
    const version = makeVersion();
    vi.mocked(apiClient.getCeoPlan).mockResolvedValue(makeGetPlanResponse({ plan }));
    vi.mocked(apiClient.getCeoPlanVersion).mockResolvedValue(version);
    vi.mocked(apiClient.listCeoApprovals).mockResolvedValue({ approvals: [] });
    vi.mocked(apiClient.getTask).mockRejectedValue(new Error("Task unavailable"));

    render(<CeoPlanDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} planId={PLAN_ID} />);

    expect(
      await screen.findByRole("heading", { name: `CEO Plan — ${PARENT_TASK_ID}` }),
    ).toBeInTheDocument();
  });

  it("deletes a cancelled plan after confirmation and returns to the CEO Plans list", async () => {
    const plan = makePlan({ status: "cancelled" });
    vi.mocked(apiClient.getCeoPlan).mockResolvedValue(makeGetPlanResponse({ plan }));
    vi.mocked(apiClient.getCeoPlanVersion).mockResolvedValue(makeVersion());
    vi.mocked(apiClient.listCeoApprovals).mockResolvedValue({ approvals: [] });
    vi.mocked(apiClient.deleteCeoPlan).mockResolvedValue({ deleted: true });

    render(<CeoPlanDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} planId={PLAN_ID} />);

    await userEvent.click(await screen.findByRole("button", { name: "Delete plan" }));
    expect(
      screen.getByText("Delete this cancelled plan? This cannot be undone."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => {
      expect(apiClient.deleteCeoPlan).toHaveBeenCalledWith(BASE_URL, PLAN_ID, "tok-1");
      expect(navigation.push).toHaveBeenCalledWith("/ceo");
    });
  });
});
