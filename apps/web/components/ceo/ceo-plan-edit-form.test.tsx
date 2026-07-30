import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CeoPlanStep, CeoPlanVersion } from "@hall-of-wisdom/protocol";
import * as apiClient from "../../lib/api-client";
import { CeoPlanEditForm } from "./ceo-plan-edit-form";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return {
    ...actual,
    createCeoPlanVersion: vi.fn(),
    getRoutingAnalysis: vi.fn(),
  };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeStep(overrides: Partial<CeoPlanStep> = {}): CeoPlanStep {
  return {
    id: "step-1",
    position: 0,
    title: "Investigate: X",
    objective: "Understand the current behavior.",
    boundedInstructions: "Read the relevant files.",
    acceptanceCriteria: ["A summary of findings is written."],
    dependencies: [],
    routingSummary: "Recommended hall.claude-code: meets every requirement.",
    ...overrides,
  };
}

function makeCeoPlanVersion(overrides: Partial<CeoPlanVersion> = {}): CeoPlanVersion {
  return {
    planId: "plan-1",
    version: 1,
    objective: "Fix the bug end to end.",
    summary: "Original summary",
    assumptions: [],
    constraints: [],
    steps: [makeStep()],
    createdAt: "2026-07-15T12:00:00.000Z",
    createdBy: "ceo_planner",
    contentHash: "a".repeat(64),
    ...overrides,
  };
}

describe("CeoPlanEditForm", () => {
  beforeEach(() => {
    vi.mocked(apiClient.createCeoPlanVersion).mockReset();
    vi.mocked(apiClient.getRoutingAnalysis).mockReset();
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue({
      taskId: "parent-1",
      requiredCapabilities: [],
      allowedExecutionTrust: [],
      candidates: [],
      explanation: "",
      generatedAt: "2026-07-15T12:00:00.000Z",
    });
  });

  it("pre-fills every field from the current active version, and Save creates a new version via createCeoPlanVersion with exactly the fields the server schema accepts — never mutates the version being viewed", async () => {
    const version = makeCeoPlanVersion({
      summary: "Original summary",
      steps: [makeStep({ id: "step-1", title: "Investigate: X" })],
    });
    const onSaved = vi.fn();
    vi.mocked(apiClient.createCeoPlanVersion).mockResolvedValue({
      plan: {
        id: "plan-1",
        parentTaskId: "parent-1",
        status: "draft",
        activeVersion: 2,
        createdAt: "2026-07-15T12:00:00.000Z",
        updatedAt: "2026-07-15T12:00:00.000Z",
        createdBy: "ceo_planner",
      },
      version: { ...version, version: 2, summary: "Edited summary" },
    });

    render(
      <CeoPlanEditForm
        baseUrl={BASE_URL}
        planId="plan-1"
        parentTaskId="parent-1"
        mutationToken="tok"
        currentVersion={version}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );

    const summaryField = screen.getByLabelText("Plan summary");
    expect(summaryField).toHaveValue("Original summary");
    await userEvent.clear(summaryField);
    await userEvent.type(summaryField, "Edited summary");
    await userEvent.click(screen.getByRole("button", { name: "Save as new version" }));

    await waitFor(() => {
      expect(apiClient.createCeoPlanVersion).toHaveBeenCalled();
    });
    const call = vi.mocked(apiClient.createCeoPlanVersion).mock.calls[0];
    expect(call?.[0]).toBe(BASE_URL);
    expect(call?.[1]).toBe("plan-1");
    const body = call?.[2];
    expect(body?.expectedMutationToken).toBe("tok");
    expect(body?.summary).toBe("Edited summary");
    // Every submitted step must contain exactly the keys the server's
    // `.strict()` editedCeoPlanStepRequestSchema accepts — never
    // `routingSummary`/`recommendedAdapterId`/`delegatedTaskId`, which
    // `CeoPlanStep` carries but a spread would silently leak through.
    expect(Object.keys(body?.steps[0] ?? {}).sort()).toEqual(
      [
        "acceptanceCriteria",
        "dependencies",
        "id",
        "objective",
        "position",
        "title",
        "boundedInstructions",
      ].sort(),
    );
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }));
  });

  it("does not offer an in-place 'Save' that mutates the existing version — only 'Save as new version'", () => {
    const version = makeCeoPlanVersion();
    render(
      <CeoPlanEditForm
        baseUrl={BASE_URL}
        planId="plan-1"
        parentTaskId="parent-1"
        mutationToken="tok"
        currentVersion={version}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Save$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as new version" })).toBeInTheDocument();
  });

  it("lets an operator reorder steps and edit dependencies, and submits the new order/dependencies verbatim", async () => {
    const version = makeCeoPlanVersion({
      steps: [
        makeStep({ id: "step-1", position: 0, title: "First" }),
        makeStep({ id: "step-2", position: 1, title: "Second" }),
      ],
    });
    vi.mocked(apiClient.createCeoPlanVersion).mockResolvedValue({
      plan: {
        id: "plan-1",
        parentTaskId: "parent-1",
        status: "draft",
        activeVersion: 2,
        createdAt: "2026-07-15T12:00:00.000Z",
        updatedAt: "2026-07-15T12:00:00.000Z",
        createdBy: "ceo_planner",
      },
      version: { ...version, version: 2 },
    });

    render(
      <CeoPlanEditForm
        baseUrl={BASE_URL}
        planId="plan-1"
        parentTaskId="parent-1"
        mutationToken="tok"
        currentVersion={version}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Move step 2 ("Second") up, ahead of step 1 ("First").
    await userEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));

    // Now "Second" is step 1, "First" is step 2 — check "Second" depends on "First".
    const dependencyCheckbox = screen.getByRole("checkbox", { name: /Step 2: First/ });
    await userEvent.click(dependencyCheckbox);

    await userEvent.click(screen.getByRole("button", { name: "Save as new version" }));

    await waitFor(() => {
      expect(apiClient.createCeoPlanVersion).toHaveBeenCalled();
    });
    const body = vi.mocked(apiClient.createCeoPlanVersion).mock.calls[0]?.[2];
    expect(body?.steps.map((s) => s.id)).toEqual(["step-2", "step-1"]);
    expect(body?.steps.map((s) => s.position)).toEqual([0, 1]);
    expect(body?.steps[0]?.dependencies).toEqual(["step-1"]);
  });

  it("removing a step strips it from every other step's dependencies", async () => {
    const version = makeCeoPlanVersion({
      steps: [
        makeStep({ id: "step-1", position: 0, title: "First" }),
        makeStep({ id: "step-2", position: 1, title: "Second", dependencies: ["step-1"] }),
      ],
    });
    vi.mocked(apiClient.createCeoPlanVersion).mockResolvedValue({
      plan: {
        id: "plan-1",
        parentTaskId: "parent-1",
        status: "draft",
        activeVersion: 2,
        createdAt: "2026-07-15T12:00:00.000Z",
        updatedAt: "2026-07-15T12:00:00.000Z",
        createdBy: "ceo_planner",
      },
      version: { ...version, version: 2 },
    });

    render(
      <CeoPlanEditForm
        baseUrl={BASE_URL}
        planId="plan-1"
        parentTaskId="parent-1"
        mutationToken="tok"
        currentVersion={version}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Remove step 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save as new version" }));

    await waitFor(() => {
      expect(apiClient.createCeoPlanVersion).toHaveBeenCalled();
    });
    const body = vi.mocked(apiClient.createCeoPlanVersion).mock.calls[0]?.[2];
    expect(body?.steps).toHaveLength(1);
    expect(body?.steps[0]?.id).toBe("step-2");
    expect(body?.steps[0]?.dependencies).toEqual([]);
  });

  it("adding a step disables Save until every required field on the new step is filled in", async () => {
    const version = makeCeoPlanVersion();
    render(
      <CeoPlanEditForm
        baseUrl={BASE_URL}
        planId="plan-1"
        parentTaskId="parent-1"
        mutationToken="tok"
        currentVersion={version}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Save as new version" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    expect(screen.getByRole("button", { name: "Save as new version" })).toBeDisabled();
    expect(
      screen.getByText(/Every field .* must be filled in before saving\./),
    ).toBeInTheDocument();
    expect(apiClient.createCeoPlanVersion).not.toHaveBeenCalled();

    await userEvent.type(
      screen.getAllByLabelText("Title")[1] ?? screen.getByLabelText("Title"),
      "New step",
    );
    await userEvent.type(
      screen.getAllByLabelText("Objective")[1] ?? screen.getByLabelText("Objective"),
      "New objective",
    );
    await userEvent.type(
      screen.getAllByLabelText("Bounded instructions")[1] ??
        screen.getByLabelText("Bounded instructions"),
      "New instructions",
    );

    expect(screen.getByRole("button", { name: "Save as new version" })).toBeEnabled();
  });

  it("Cancel calls onCancel without submitting anything", async () => {
    const onCancel = vi.fn();
    const version = makeCeoPlanVersion();
    render(
      <CeoPlanEditForm
        baseUrl={BASE_URL}
        planId="plan-1"
        parentTaskId="parent-1"
        mutationToken="tok"
        currentVersion={version}
        onSaved={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(apiClient.createCeoPlanVersion).not.toHaveBeenCalled();
  });
});
