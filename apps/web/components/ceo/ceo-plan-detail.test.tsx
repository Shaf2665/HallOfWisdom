import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { CeoPlan, CeoPlanVersion, GetCeoPlanResponse } from "../../lib/api-schemas";
import { CeoPlanDetail } from "./ceo-plan-detail";

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

describe("CeoPlanDetail", () => {
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
});
