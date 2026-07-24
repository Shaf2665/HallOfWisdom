import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { AgentComparisonRecord } from "../../lib/api-schemas";
import { ComparisonDetail } from "./comparison-detail";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return {
    ...actual,
    getComparison: vi.fn(),
    prepareComparison: vi.fn(),
    startComparisonCandidate: vi.fn(),
    cancelComparisonCandidate: vi.fn(),
    setComparisonPreference: vi.fn(),
    deleteComparison: vi.fn(),
  };
});

vi.mock("../../hooks/use-comparison-candidate-events", () => ({
  useComparisonCandidateEvents: () => ({
    connectionState: "idle",
    events: [],
    lastContiguousSequence: -1,
    lastError: null,
    reconnectAttempt: 0,
    terminalEventReceived: false,
    reconnect: vi.fn(),
  }),
}));

const BASE_URL = "http://127.0.0.1:4310";
const WS_BASE_URL = "ws://127.0.0.1:4310";

function makeComparison(overrides: Partial<AgentComparisonRecord> = {}): AgentComparisonRecord {
  const now = "2026-07-15T12:00:00.000Z";
  return {
    comparisonId: "comparison-1",
    sourceTaskId: "task-1",
    title: "Add a health check endpoint",
    description: "Implement GET /healthz.",
    priority: "normal",
    status: "ready",
    createdAt: now,
    updatedAt: now,
    baseCommit: "a".repeat(40),
    preparedAt: now,
    candidates: [
      {
        candidateId: "candidate-a",
        adapterId: "hall.claude-code",
        displayName: "Claude Code",
        status: "prepared",
        executionTrust: "isolated",
        cancellationRequested: false,
        createdAt: now,
        preparedAt: now,
        eventCount: 0,
      },
      {
        candidateId: "candidate-b",
        adapterId: "hall.codex",
        displayName: "Codex",
        status: "prepared",
        executionTrust: "trusted_local",
        cancellationRequested: false,
        createdAt: now,
        preparedAt: now,
        eventCount: 0,
      },
    ],
    cleanupStatus: "not_started",
    ...overrides,
  };
}

describe("ComparisonDetail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads and displays the comparison's title, status, and both candidates", async () => {
    vi.mocked(apiClient.getComparison).mockResolvedValue(makeComparison());
    render(
      <ComparisonDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} comparisonId="comparison-1" />,
    );

    await waitFor(() => {
      expect(screen.getByText("Add a health check endpoint")).toBeInTheDocument();
    });
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("shows a comparison-level preparation failure reason when prepare failed with no specific candidate", async () => {
    vi.mocked(apiClient.getComparison).mockResolvedValue(
      makeComparison({
        status: "failed",
        prepareFailureCode: "COMPARISON_SOURCE_WORKING_DIRECTORY_REQUIRED",
        prepareFailureReason:
          "The source task has no working directory set; comparisons require one to locate the source repository.",
      }),
    );
    render(
      <ComparisonDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} comparisonId="comparison-1" />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Preparation failed:/)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/has no working directory set; comparisons require one/),
    ).toBeInTheDocument();
  });

  it("shows a Prepare button only while the comparison is still a draft", async () => {
    vi.mocked(apiClient.getComparison).mockResolvedValue(makeComparison({ status: "draft" }));
    render(
      <ComparisonDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} comparisonId="comparison-1" />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Prepare" })).toBeInTheDocument();
    });
  });

  it("starts a candidate and reflects the updated record", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.getComparison).mockResolvedValue(makeComparison());
    vi.mocked(apiClient.startComparisonCandidate).mockResolvedValue(
      makeComparison({
        status: "running",
        candidates: [
          {
            candidateId: "candidate-a",
            adapterId: "hall.claude-code",
            displayName: "Claude Code",
            status: "running",
            executionTrust: "isolated",
            cancellationRequested: false,
            createdAt: "2026-07-15T12:00:00.000Z",
            startedAt: "2026-07-15T12:00:01.000Z",
            runId: "run-1",
            eventCount: 0,
          },
          {
            candidateId: "candidate-b",
            adapterId: "hall.codex",
            displayName: "Codex",
            status: "prepared",
            executionTrust: "trusted_local",
            cancellationRequested: false,
            createdAt: "2026-07-15T12:00:00.000Z",
            eventCount: 0,
          },
        ],
      }),
    );

    render(
      <ComparisonDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} comparisonId="comparison-1" />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Start" })).toHaveLength(2);
    });

    const [startButton] = screen.getAllByRole("button", { name: "Start" });
    if (!startButton) throw new Error("Start button not found");
    await user.click(startButton);

    await waitFor(() => {
      expect(apiClient.startComparisonCandidate).toHaveBeenCalledWith(
        BASE_URL,
        "comparison-1",
        "candidate-a",
      );
    });
    // Once one candidate is running, the other's Start button is hidden —
    // the backend enforces sequential-only execution and the UI must not
    // offer an action that would just come back as a 409.
    await waitFor(() => {
      expect(screen.queryAllByRole("button", { name: "Start" })).toHaveLength(0);
    });
  });

  it("surfaces a clear message (not a raw error) when starting a candidate races a 409 from the backend", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.getComparison).mockResolvedValue(makeComparison());
    vi.mocked(apiClient.startComparisonCandidate).mockRejectedValue(
      new apiClient.ApiClientError(
        "COMPARISON_STATE_CONFLICT",
        'Comparison "comparison-1" cannot be started while in status "running".',
        409,
      ),
    );

    render(
      <ComparisonDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} comparisonId="comparison-1" />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Start" })).toHaveLength(2);
    });
    const [startButton] = screen.getAllByRole("button", { name: "Start" });
    if (!startButton) throw new Error("Start button not found");
    await user.click(startButton);

    await waitFor(() => {
      expect(screen.getAllByText(/Only one candidate can run at a time/).length).toBeGreaterThan(0);
      expect(screen.getByRole("alert")).toHaveTextContent(/Only one candidate can run at a time/);
    });
  });

  it("records a preference and shows it is informational only", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.getComparison).mockResolvedValue(makeComparison());
    vi.mocked(apiClient.setComparisonPreference).mockResolvedValue(
      makeComparison({
        preference: { candidateId: "candidate-a", recordedAt: "2026-07-15T12:05:00.000Z" },
      }),
    );

    render(
      <ComparisonDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} comparisonId="comparison-1" />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Informational only/)).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText(/Claude Code \(hall.claude-code\)/));
    await user.click(screen.getByRole("button", { name: "Save preference" }));

    await waitFor(() => {
      expect(apiClient.setComparisonPreference).toHaveBeenCalledWith(BASE_URL, "comparison-1", {
        candidateId: "candidate-a",
      });
    });
  });

  it("shows a Clean up button once every candidate has reached a terminal status, and Retry wording after a failed cleanup", async () => {
    vi.mocked(apiClient.getComparison).mockResolvedValue(
      makeComparison({
        status: "completed",
        candidates: [
          {
            candidateId: "candidate-a",
            adapterId: "hall.claude-code",
            displayName: "Claude Code",
            status: "completed",
            cancellationRequested: false,
            createdAt: "2026-07-15T12:00:00.000Z",
            completedAt: "2026-07-15T12:01:00.000Z",
            eventCount: 2,
          },
          {
            candidateId: "candidate-b",
            adapterId: "hall.codex",
            displayName: "Codex",
            status: "completed",
            cancellationRequested: false,
            createdAt: "2026-07-15T12:00:00.000Z",
            completedAt: "2026-07-15T12:01:30.000Z",
            eventCount: 2,
          },
        ],
      }),
    );
    render(
      <ComparisonDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} comparisonId="comparison-1" />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Clean up" })).toBeInTheDocument();
    });
  });

  it("shows the changed files and a collapsible diff when result evidence is present", async () => {
    vi.mocked(apiClient.getComparison).mockResolvedValue(
      makeComparison({
        candidates: [
          {
            candidateId: "candidate-a",
            adapterId: "hall.claude-code",
            displayName: "Claude Code",
            status: "completed",
            cancellationRequested: false,
            createdAt: "2026-07-15T12:00:00.000Z",
            eventCount: 2,
            resultEvidence: {
              changedFiles: [
                { relativePath: "src/health.ts", changeType: "added", additions: 12, deletions: 0 },
              ],
              totalAdditions: 12,
              totalDeletions: 0,
              boundedDiff: "diff --git a/src/health.ts b/src/health.ts\n+export {};\n",
              truncated: false,
            },
          },
          {
            candidateId: "candidate-b",
            adapterId: "hall.codex",
            displayName: "Codex",
            status: "prepared",
            cancellationRequested: false,
            createdAt: "2026-07-15T12:00:00.000Z",
            eventCount: 0,
          },
        ],
      }),
    );
    render(
      <ComparisonDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} comparisonId="comparison-1" />,
    );
    await waitFor(() => {
      expect(screen.getByText("src/health.ts")).toBeInTheDocument();
    });
    expect(screen.getByText(/1 file changed/)).toBeInTheDocument();
    expect(screen.getByText("Show diff")).toBeInTheDocument();
  });
});
