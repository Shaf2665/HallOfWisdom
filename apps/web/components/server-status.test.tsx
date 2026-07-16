import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerStatus } from "./server-status";
import * as apiClient from "../lib/api-client";

vi.mock("../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/api-client")>("../lib/api-client");
  return { ...actual, getHealth: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

describe("ServerStatus", () => {
  beforeEach(() => {
    vi.mocked(apiClient.getHealth).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows Online with the protocol version once the health check succeeds", async () => {
    vi.mocked(apiClient.getHealth).mockResolvedValue({
      status: "ok",
      application: "hall-core",
      protocolVersion: "0.1",
      uptimeSeconds: 10,
    });
    render(<ServerStatus baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getByText(/Online/)).toBeInTheDocument();
    });
    expect(screen.getByText(/protocol v0.1/)).toBeInTheDocument();
  });

  it("shows Offline and a Retry button when the health check fails", async () => {
    vi.mocked(apiClient.getHealth).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );
    render(<ServerStatus baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getByText(/Offline/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("retrying calls the health endpoint again", async () => {
    vi.mocked(apiClient.getHealth).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );
    const user = userEvent.setup();
    render(<ServerStatus baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });
    const callsBefore = vi.mocked(apiClient.getHealth).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(vi.mocked(apiClient.getHealth).mock.calls.length).toBeGreaterThan(callsBefore);
  });
});
