import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { RoutingAnalysisResponse, RoutingCandidate } from "../../lib/api-schemas";
import { CeoStepAdapterSelector } from "./ceo-step-adapter-selector";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, getRoutingAnalysis: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeCandidate(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    availability: "available",
    assignable: true,
    executionTrust: "isolated",
    verifiedCapabilities: [],
    missingCapabilities: [],
    restrictedCapabilities: [],
    trustAllowed: true,
    safeReason: "Meets every required capability and its execution trust is allowed.",
    rank: 1,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<RoutingAnalysisResponse> = {}): RoutingAnalysisResponse {
  return {
    taskId: "parent-1",
    requiredCapabilities: [],
    allowedExecutionTrust: ["isolated"],
    candidates: [makeCandidate()],
    recommendedAdapterId: "hall.claude-code",
    explanation: 'Recommended "Claude Code".',
    generatedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("CeoStepAdapterSelector", () => {
  beforeEach(() => {
    vi.mocked(apiClient.getRoutingAnalysis).mockReset();
  });

  it("fetches candidates for the step's own requirements and renders eligible adapters selectable, ineligible ones disabled with their bounded reason", async () => {
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue(
      makeAnalysis({
        candidates: [
          makeCandidate({ adapterId: "hall.claude-code", displayName: "Claude Code" }),
          makeCandidate({
            adapterId: "hall.mock-agent",
            displayName: "Mock Agent",
            assignable: false,
            executionTrust: "simulated",
            safeReason: "Excluded: this step's requirements do not allow simulated execution.",
          }),
        ],
      }),
    );

    render(
      <CeoStepAdapterSelector
        baseUrl={BASE_URL}
        parentTaskId="parent-1"
        requirements={{ requiredCapabilities: [], allowedExecutionTrust: ["isolated"] }}
        selectedAdapterId={undefined}
        recommendedAdapterId="hall.claude-code"
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("radio", { name: /hall\.claude-code/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /hall\.mock-agent/ })).toBeDisabled();
    expect(
      screen.getByText(/Excluded: this step's requirements do not allow simulated execution\./),
    ).toBeInTheDocument();

    const call = vi.mocked(apiClient.getRoutingAnalysis).mock.calls[0];
    expect(call?.[0]).toBe(BASE_URL);
    expect(call?.[1]).toBe("parent-1");
    expect(call?.[2]).toEqual({ requiredCapabilities: [], allowedExecutionTrust: ["isolated"] });
    expect(call?.[3]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("selecting an adapter calls onChange with its id; explicitly reverting to the recommendation calls onChange with undefined", async () => {
    const onChange = vi.fn();
    vi.mocked(apiClient.getRoutingAnalysis).mockResolvedValue(
      makeAnalysis({
        candidates: [
          makeCandidate({ adapterId: "hall.claude-code", displayName: "Claude Code" }),
          makeCandidate({ adapterId: "hall.mock-agent", displayName: "Mock Agent" }),
        ],
        recommendedAdapterId: "hall.claude-code",
      }),
    );

    const { rerender } = render(
      <CeoStepAdapterSelector
        baseUrl={BASE_URL}
        parentTaskId="parent-1"
        requirements={{ requiredCapabilities: [], allowedExecutionTrust: ["isolated"] }}
        selectedAdapterId={undefined}
        recommendedAdapterId="hall.claude-code"
        onChange={onChange}
      />,
    );

    await userEvent.click(await screen.findByRole("radio", { name: /hall\.mock-agent/ }));
    expect(onChange).toHaveBeenCalledWith("hall.mock-agent");

    // The real parent (`CeoPlanEditForm`) would re-render with the newly
    // selected id after `onChange` — mirror that here, since a radio
    // input never fires a change event on a redundant click.
    rerender(
      <CeoStepAdapterSelector
        baseUrl={BASE_URL}
        parentTaskId="parent-1"
        requirements={{ requiredCapabilities: [], allowedExecutionTrust: ["isolated"] }}
        selectedAdapterId="hall.mock-agent"
        recommendedAdapterId="hall.claude-code"
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole("radio", { name: /hall\.claude-code/ }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("when the step has no requirements at all, shows a message explaining nothing can be recommended, without fetching", async () => {
    render(
      <CeoStepAdapterSelector
        baseUrl={BASE_URL}
        parentTaskId="parent-1"
        requirements={undefined}
        selectedAdapterId={undefined}
        recommendedAdapterId={undefined}
        onChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/does not have capability or execution-trust requirements set/),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(apiClient.getRoutingAnalysis).not.toHaveBeenCalled();
    });
  });
});
