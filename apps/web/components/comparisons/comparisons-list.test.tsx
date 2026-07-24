import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import * as apiClient from "../../lib/api-client";
import type { AgentComparisonRecord } from "../../lib/api-schemas";
import { ComparisonsList } from "./comparisons-list";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, listComparisons: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeCandidate(
  overrides: Partial<AgentComparisonRecord["candidates"][number]> = {},
): AgentComparisonRecord["candidates"][number] {
  return {
    candidateId: "candidate-a",
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    status: "pending",
    cancellationRequested: false,
    createdAt: "2026-07-15T12:00:00.000Z",
    eventCount: 0,
    ...overrides,
  };
}

function makeComparison(overrides: Partial<AgentComparisonRecord> = {}): AgentComparisonRecord {
  return {
    comparisonId: "comparison-1",
    sourceTaskId: "task-1",
    title: "Add a health check endpoint",
    description: "",
    priority: "normal",
    status: "draft",
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    candidates: [
      makeCandidate({ candidateId: "candidate-a", adapterId: "hall.claude-code" }),
      makeCandidate({ candidateId: "candidate-b", adapterId: "hall.codex" }),
    ],
    cleanupStatus: "not_started",
    ...overrides,
  };
}

describe("ComparisonsList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a loading state, then the empty-state message when there are no comparisons", async () => {
    vi.mocked(apiClient.listComparisons).mockResolvedValue({ comparisons: [] });
    render(<ComparisonsList baseUrl={BASE_URL} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading comparisons");
    await waitFor(() => {
      expect(screen.getByText(/No comparisons yet/)).toBeInTheDocument();
    });
  });

  it("shows an error message when the fetch fails, never a raw error", async () => {
    vi.mocked(apiClient.listComparisons).mockRejectedValue(
      new apiClient.ApiClientError("INTERNAL_ERROR", "Something went wrong on the server."),
    );
    render(<ComparisonsList baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong on the server.");
    });
  });

  it("lists every comparison with its title, status, and candidate adapters, linking to its detail page", async () => {
    vi.mocked(apiClient.listComparisons).mockResolvedValue({
      comparisons: [makeComparison({ comparisonId: "comparison-1", status: "ready" })],
    });
    render(<ComparisonsList baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getAllByText("Add a health check endpoint").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    const links = screen.getAllByRole("link", { name: "Add a health check endpoint" });
    expect(links[0]).toHaveAttribute("href", "/comparisons/comparison-1");
  });

  it("sorts newest-first by createdAt", async () => {
    vi.mocked(apiClient.listComparisons).mockResolvedValue({
      comparisons: [
        makeComparison({
          comparisonId: "older",
          title: "Older comparison",
          createdAt: "2026-07-15T10:00:00.000Z",
        }),
        makeComparison({
          comparisonId: "newer",
          title: "Newer comparison",
          createdAt: "2026-07-15T12:00:00.000Z",
        }),
      ],
    });
    render(<ComparisonsList baseUrl={BASE_URL} />);
    await waitFor(() => {
      const links = screen.getAllByRole("link");
      expect(links[0]).toHaveAttribute("href", "/comparisons/newer");
    });
  });
});
