import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { AdapterSummary } from "../../lib/api-schemas";
import { ProvidersPanel } from "./providers-panel";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, listAdapters: vi.fn(), getAdapter: vi.fn() };
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

describe("ProvidersPanel", () => {
  beforeEach(() => {
    vi.mocked(apiClient.listAdapters).mockReset();
    vi.mocked(apiClient.getAdapter).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders Claude Code, Codex, and Hermes Router, never Mock Agent", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        makeAdapter({ adapterId: "hall.mock-agent", displayName: "Mock Agent" }),
        makeAdapter(),
        makeAdapter({ adapterId: "hall.codex", displayName: "Codex" }),
        makeAdapter({ adapterId: "hall.hermes-router", displayName: "Hermes Router" }),
      ],
    });
    render(<ProvidersPanel baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
    });
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Hermes Router")).toBeInTheDocument();
    expect(screen.queryByText("Mock Agent")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(
      screen.getByText(/Hermes Router setup is saved locally from Settings/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/never asks for upstream provider keys/i)).toBeInTheDocument();
  });

  it("shows a loading state, then an accessible error state on failure", async () => {
    vi.mocked(apiClient.listAdapters).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );
    render(<ProvidersPanel baseUrl={BASE_URL} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Hall Core.");
  });

  it("updates only the rechecked provider's card, leaving the other unchanged", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        makeAdapter({ availability: "logged_out", assignable: false }),
        makeAdapter({ adapterId: "hall.codex", displayName: "Codex" }),
      ],
    });
    vi.mocked(apiClient.getAdapter).mockResolvedValue({
      adapter: makeAdapter({ availability: "available" }),
    });
    const user = userEvent.setup();
    render(<ProvidersPanel baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Not connected")).toHaveLength(1);
    expect(screen.getAllByText("Connected")).toHaveLength(1);

    const cards = screen.getAllByRole("listitem");
    const claudeCodeCard = cards.find((card) => within(card).queryByText("Claude Code"));
    if (!claudeCodeCard) throw new Error("Claude Code card not found");
    await user.click(within(claudeCodeCard).getByRole("button", { name: "Recheck" }));

    await waitFor(() => {
      expect(within(claudeCodeCard).getByText("Connected")).toBeInTheDocument();
    });
    // Codex's own card must be untouched — a `handleUpdated` that replaces
    // every adapter instead of matching by `adapterId` would clobber Codex
    // with the rechecked Claude Code summary and make this fail.
    const codexCard = cards.find((card) => within(card).queryByText("Codex"));
    if (!codexCard) throw new Error("Codex card not found");
    expect(within(codexCard).getByText("Codex")).toBeInTheDocument();
    expect(within(codexCard).getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.getAllByText("Connected")).toHaveLength(2);
  });
});
