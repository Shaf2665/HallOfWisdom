import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { AdapterSummary } from "../../lib/api-schemas";
import { ProviderCard } from "./provider-card";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, getAdapter: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeAdapter(overrides: Partial<AdapterSummary> = {}): AdapterSummary {
  return {
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    adapterVersion: "1.0.0",
    agentId: "claude-code",
    agentDisplayName: "Claude Code",
    integrationLevel: "structured_cli",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
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
    executionTrust: "isolated",
    capabilityObservations: [],
    limitations: [],
    detectedAt: "2026-08-08T12:00:00.000Z",
    ...overrides,
  };
}

describe("ProviderCard", () => {
  beforeEach(() => {
    vi.mocked(apiClient.getAdapter).mockReset();
    // jsdom 25 defines `navigator.clipboard` as a getter-only accessor, so a
    // plain `Object.assign` throws — `defineProperty` overrides it instead.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows Connected for an available provider", () => {
    render(
      <ProviderCard baseUrl={BASE_URL} adapter={makeAdapter()} onUpdated={vi.fn()} />,
    );
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows Not connected plus the adapter's own guidance for a logged-out provider", () => {
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({
          availability: "logged_out",
          assignable: false,
          statusMessage: "Claude Code is installed but not logged in.",
        })}
        onUpdated={vi.fn()}
      />,
    );
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Claude Code is installed but not logged in.")).toBeInTheDocument();
  });

  it("Connect reveals the exact official login command", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({ availability: "logged_out", assignable: false })}
        onUpdated={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByText("claude login")).toBeInTheDocument();
  });

  it("never shows a Connect button for an adapter with no known login command", () => {
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({ adapterId: "hall.mock-agent", displayName: "Mock Agent" })}
        onUpdated={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("Recheck calls getAdapter for this adapter's id and reports the refreshed summary via onUpdated", async () => {
    const updated = makeAdapter({ availability: "available", statusMessage: "Now connected." });
    vi.mocked(apiClient.getAdapter).mockResolvedValue({ adapter: updated });
    const onUpdated = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({ availability: "logged_out", assignable: false })}
        onUpdated={onUpdated}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => {
      expect(apiClient.getAdapter).toHaveBeenCalledWith(BASE_URL, "hall.claude-code", {});
    });
    expect(onUpdated).toHaveBeenCalledWith(updated);
  });

  it("shows an accessible error message when Recheck fails", async () => {
    vi.mocked(apiClient.getAdapter).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );
    const user = userEvent.setup();
    render(
      <ProviderCard baseUrl={BASE_URL} adapter={makeAdapter()} onUpdated={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Recheck" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Hall Core.");
  });

  it("always shows the trusted-local warning, unsoftened, when executionTrust is trusted_local", () => {
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({
          adapterId: "hall.codex",
          displayName: "Codex",
          executionTrust: "trusted_local",
        })}
        onUpdated={vi.fn()}
      />,
    );
    expect(screen.getByText(/not OS-sandboxed/)).toBeInTheDocument();
  });

  it("hides technical details (adapterId, integrationLevel, raw availability) until expanded", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCard baseUrl={BASE_URL} adapter={makeAdapter()} onUpdated={vi.fn()} />,
    );
    expect(screen.queryByText("hall.claude-code")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show technical details" }));
    expect(screen.getByText("hall.claude-code")).toBeInTheDocument();
  });

  it("never renders executablePath, CODEX_HOME, or other leaked technical data", () => {
    const { container } = render(
      <ProviderCard baseUrl={BASE_URL} adapter={makeAdapter()} onUpdated={vi.fn()} />,
    );
    expect(container.innerHTML).not.toContain("executablePath");
    expect(container.innerHTML).not.toContain("CODEX_HOME");
  });
});
