import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import * as apiClient from "../../lib/api-client";
import type { SystemStorageResponse } from "../../lib/api-schemas";
import { StorageStatus } from "./storage-status";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, getSystemStorage: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeStorage(overrides: Partial<SystemStorageResponse> = {}): SystemStorageResponse {
  return {
    mode: "in-memory",
    ready: true,
    schemaVersion: null,
    startedAt: "2026-07-15T12:00:00.000Z",
    previousShutdown: null,
    recovery: null,
    ...overrides,
  };
}

describe("StorageStatus", () => {
  beforeEach(() => {
    vi.mocked(apiClient.getSystemStorage).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the in-memory notice and never shows a recovery section when storage is ephemeral", async () => {
    vi.mocked(apiClient.getSystemStorage).mockResolvedValue(makeStorage({ mode: "in-memory" }));
    render(<StorageStatus baseUrl={BASE_URL} />);

    await waitFor(() => {
      expect(screen.getByText("In-memory")).toBeInTheDocument();
    });
    expect(screen.getByText(/running purely in memory/)).toBeInTheDocument();
    expect(screen.queryByText("Last restart recovery")).not.toBeInTheDocument();
  });

  it("renders the recovery summary and worktree health badges when storage is durable", async () => {
    vi.mocked(apiClient.getSystemStorage).mockResolvedValue(
      makeStorage({
        mode: "durable",
        schemaVersion: 1,
        previousShutdown: "unclean",
        recovery: {
          tasksScanned: 5,
          taskEventProjectionsRepaired: 2,
          taskTerminalOutcomesReplayed: 1,
          interruptedTaskRunCount: 1,
          comparisonsScanned: 1,
          interruptedPreparationCount: 0,
          interruptedCleanupCount: 0,
          comparisonEventProjectionsRepaired: 0,
          comparisonTerminalOutcomesReplayed: 0,
          interruptedCandidateRunCount: 0,
          worktreeHealthCounts: {
            healthy: 2,
            interrupted: 0,
            workspace_missing: 1,
            workspace_unverified: 0,
            cleanup_required: 0,
            unsafe_path: 0,
          },
          orphanWorktreeCount: 0,
        },
      }),
    );
    render(<StorageStatus baseUrl={BASE_URL} />);

    await waitFor(() => {
      expect(screen.getByText("Durable")).toBeInTheDocument();
    });
    expect(screen.getByText("Unclean (interrupted)")).toBeInTheDocument();
    expect(screen.getByText("Last restart recovery")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText(/Healthy: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Missing: 1/)).toBeInTheDocument();
  });

  it("shows a safe error message, never a raw error, when the request fails", async () => {
    vi.mocked(apiClient.getSystemStorage).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core.", 0),
    );
    render(<StorageStatus baseUrl={BASE_URL} />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Could not reach Hall Core.");
    });
  });
});
