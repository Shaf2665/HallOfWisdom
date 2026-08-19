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
    render(<ProviderCard baseUrl={BASE_URL} adapter={makeAdapter()} onUpdated={vi.fn()} />);
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

  it.each([
    ["hall.claude-code", "Claude Code", "claude auth login"],
    ["hall.codex", "Codex", "codex login"],
  ])(
    "Connect preserves the official login command for %s",
    async (adapterId, displayName, command) => {
      const user = userEvent.setup();
      render(
        <ProviderCard
          baseUrl={BASE_URL}
          adapter={makeAdapter({
            adapterId,
            displayName,
            availability: "logged_out",
            assignable: false,
          })}
          onUpdated={vi.fn()}
        />,
      );
      await user.click(screen.getByRole("button", { name: "Connect" }));
      expect(screen.getByText(command)).toBeInTheDocument();
    },
  );

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

  it("shows Hermes as Connected only when the server reports available", () => {
    const { rerender } = render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({
          adapterId: "hall.hermes-router",
          displayName: "Hermes Router",
          availability: "available",
          executionTrust: "isolated",
        })}
        onUpdated={vi.fn()}
      />,
    );
    expect(screen.getByText("Connected")).toBeInTheDocument();

    rerender(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({
          adapterId: "hall.hermes-router",
          displayName: "Hermes Router",
          availability: "unsupported",
          assignable: false,
          executionTrust: "unavailable",
          statusMessage: "Hermes requires Hall durable isolated-worktree execution.",
        })}
        onUpdated={vi.fn()}
      />,
    );
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(
      screen.getByText("Hermes requires Hall durable isolated-worktree execution."),
    ).toBeInTheDocument();
  });

  it.each([
    ["unavailable", "Hall's bundled Hermes execution runtime was not found."],
    ["unsupported", "Hermes coding runtime is installed but its configured router is unavailable."],
  ] as const)(
    "shows Hermes as Not connected with server guidance when availability is %s",
    (availability, statusMessage) => {
      render(
        <ProviderCard
          baseUrl={BASE_URL}
          adapter={makeAdapter({
            adapterId: "hall.hermes-router",
            displayName: "Hermes Router",
            availability,
            assignable: false,
            executionTrust: "unavailable",
            statusMessage,
          })}
          onUpdated={vi.fn()}
        />,
      );

      expect(screen.getByText("Not connected")).toBeInTheDocument();
      expect(screen.getByText(statusMessage)).toBeInTheDocument();
    },
  );

  it("sends Hermes setup to Settings and keeps advanced environment overrides technical", async () => {
    const browserStorageSet = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({
          adapterId: "hall.hermes-router",
          displayName: "Hermes Router",
          availability: "unsupported",
          assignable: false,
          executionTrust: "unavailable",
        })}
        onUpdated={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Setup" }));
    const guide = screen.getByRole("region", { name: "Hermes Router setup guide" });
    expect(guide).toHaveTextContent("save and verify your local Hermes Router setup");
    expect(screen.getByRole("link", { name: "Open Hermes settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(guide).toHaveTextContent("HALL_HERMES_ROUTER_ROOT");
    expect(guide).toHaveTextContent("HERMES_ROUTER_BASE_URL");
    expect(guide).toHaveTextContent("HERMES_ROUTER_API_KEY");
    expect(guide).toHaveTextContent("HALL_HERMES_PYTHON");
    expect(guide.querySelector("input, textarea, select")).toBeNull();
    expect(browserStorageSet).not.toHaveBeenCalled();
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

  it("Recheck uses the existing single-adapter flow for Hermes", async () => {
    const updated = makeAdapter({
      adapterId: "hall.hermes-router",
      displayName: "Hermes Router",
      availability: "available",
      executionTrust: "isolated",
    });
    vi.mocked(apiClient.getAdapter).mockResolvedValue({ adapter: updated });
    const onUpdated = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({
          adapterId: "hall.hermes-router",
          displayName: "Hermes Router",
          availability: "unsupported",
          assignable: false,
          executionTrust: "unavailable",
        })}
        onUpdated={onUpdated}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => {
      expect(apiClient.getAdapter).toHaveBeenCalledWith(BASE_URL, "hall.hermes-router", {});
    });
    expect(onUpdated).toHaveBeenCalledWith(updated);
  });

  it("shows an accessible error message when Recheck fails", async () => {
    vi.mocked(apiClient.getAdapter).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );
    const user = userEvent.setup();
    render(<ProviderCard baseUrl={BASE_URL} adapter={makeAdapter()} onUpdated={vi.fn()} />);
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

  it("shows Hermes execution trust and runtime metadata only after technical details expand", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({
          adapterId: "hall.hermes-router",
          displayName: "Hermes Router",
          adapterVersion: "0.1.0",
          detectedVersion: "0.2.0",
          declaredCapabilities: ["project.read", "structured.events"],
          executionTrust: "isolated",
        })}
        onUpdated={vi.fn()}
      />,
    );
    expect(screen.queryByText("hall.hermes-router")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show technical details" }));
    expect(screen.getByText("hall.hermes-router")).toBeInTheDocument();
    expect(screen.getByText("structured_cli")).toBeInTheDocument();
    expect(screen.getByText("0.2.0")).toBeInTheDocument();
    expect(screen.getByText("available")).toBeInTheDocument();
    expect(screen.getByText("project.read, structured.events")).toBeInTheDocument();
    expect(screen.getByText("Execution trust")).toBeInTheDocument();
    expect(screen.getByText("isolated")).toBeInTheDocument();
  });

  it("never renders executablePath, CODEX_HOME, or other leaked technical data", () => {
    const { container } = render(
      <ProviderCard baseUrl={BASE_URL} adapter={makeAdapter()} onUpdated={vi.fn()} />,
    );
    expect(container.innerHTML).not.toContain("executablePath");
    expect(container.innerHTML).not.toContain("CODEX_HOME");
  });
});
