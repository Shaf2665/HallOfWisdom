import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import * as apiClient from "../../lib/api-client";
import type { AdapterSummary } from "../../lib/api-schemas";
import { AgentsCatalog } from "./agents-catalog";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, listAdapters: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeAdapter(overrides: Partial<AdapterSummary> = {}): AdapterSummary {
  return {
    adapterId: "hall.mock-agent",
    displayName: "Mock Agent",
    adapterVersion: "0.1.0",
    agentId: "mock-agent",
    agentDisplayName: "Mock Agent",
    integrationLevel: "native",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
      toolEvents: true,
      fileEditing: false,
      shellExecution: false,
      subagents: false,
      mcp: false,
      acp: false,
    },
    availability: "available",
    declaredCapabilities: ["structured.events", "cancellation"],
    assignable: true,
    executionTrust: "simulated",
    capabilityObservations: [
      {
        capability: "structured.events",
        status: "verified",
        safeSummary: "Verified by deterministic tests.",
        evidence: "deterministic_test",
      },
    ],
    limitations: [],
    detectedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("AgentsCatalog", () => {
  beforeEach(() => {
    vi.mocked(apiClient.listAdapters).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders every registered adapter with its execution trust clearly labelled", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        makeAdapter(),
        makeAdapter({
          adapterId: "hall.codex",
          displayName: "Codex",
          executionTrust: "trusted_local",
          provider: "OpenAI",
        }),
      ],
    });
    render(<AgentsCatalog baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getAllByText("Mock Agent").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("simulated").length).toBeGreaterThan(0);
    expect(screen.getAllByText("trusted_local").length).toBeGreaterThan(0);
  });

  it("never softens trusted-local's label — it always reads exactly 'trusted_local', never 'isolated'", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [makeAdapter({ adapterId: "hall.codex", executionTrust: "trusted_local" })],
    });
    render(<AgentsCatalog baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getAllByText("trusted_local").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("isolated")).not.toBeInTheDocument();
  });

  it("shows Mock Agent as clearly simulated", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    render(<AgentsCatalog baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getAllByText("simulated").length).toBeGreaterThan(0);
    });
  });

  it("shows a visible limitation when the adapter reports one", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        makeAdapter({
          adapterId: "hall.codex",
          executionTrust: "trusted_local",
          limitations: [
            "Trusted-local mode: Codex sandbox and approval protections are bypassed. Codex runs with the Hall Core user's filesystem permissions.",
          ],
        }),
      ],
    });
    render(<AgentsCatalog baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(
        screen.getAllByText(/sandbox and approval protections are bypassed/).length,
      ).toBeGreaterThan(0);
    });
  });

  it("never renders executable-path or account-shaped data — only the safe, allowlisted fields", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    const { container } = render(<AgentsCatalog baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getAllByText("Mock Agent").length).toBeGreaterThan(0);
    });
    expect(container.innerHTML).not.toContain("executablePath");
    expect(container.innerHTML).not.toContain("CODEX_HOME");
    expect(container.innerHTML).not.toContain(".exe");
  });

  it("shows an accessible error state when adapters cannot be loaded", async () => {
    vi.mocked(apiClient.listAdapters).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );
    render(<AgentsCatalog baseUrl={BASE_URL} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Hall Core.");
  });

  it("explains that installed does not mean executable and other Phase 11 caveats", () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({ adapters: [makeAdapter()] });
    render(<AgentsCatalog baseUrl={BASE_URL} />);
    expect(screen.getByText(/Installed does not mean executable/)).toBeInTheDocument();
    expect(screen.getByText(/Authenticated does not mean isolated/)).toBeInTheDocument();
  });
});
