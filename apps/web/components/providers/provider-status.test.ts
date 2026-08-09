import { describe, expect, it } from "vitest";
import type { AdapterSummary } from "../../lib/api-schemas";
import {
  connectCommandFor,
  deriveConnectionState,
  deriveGuidanceText,
  isKnownProviderAdapter,
} from "./provider-status";

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

describe("deriveConnectionState", () => {
  it("is 'connected' exactly when availability is 'available'", () => {
    expect(deriveConnectionState(makeAdapter({ availability: "available" }))).toBe("connected");
  });

  it.each(["logged_out", "unavailable", "unsupported", "busy", "rate_limited", "offline"] as const)(
    "is 'not-connected' for availability %s",
    (availability) => {
      expect(deriveConnectionState(makeAdapter({ availability }))).toBe("not-connected");
    },
  );
});

describe("deriveGuidanceText", () => {
  it("prefers statusMessage when present, over any generic fallback", () => {
    const adapter = makeAdapter({
      availability: "logged_out",
      statusMessage: "Claude Code is installed but not logged in.",
    });
    expect(deriveGuidanceText(adapter)).toBe("Claude Code is installed but not logged in.");
  });

  it("falls back to a fixed, plain-language message per availability when statusMessage is absent", () => {
    const adapter = makeAdapter({ availability: "logged_out", statusMessage: undefined });
    expect(deriveGuidanceText(adapter)).toMatch(/not logged in/i);
  });

  it("has a distinct fallback for every AvailabilityStatus value, never returning an empty string", () => {
    const values = [
      "available",
      "busy",
      "rate_limited",
      "logged_out",
      "offline",
      "unavailable",
      "unsupported",
    ] as const;
    for (const availability of values) {
      const text = deriveGuidanceText(makeAdapter({ availability, statusMessage: undefined }));
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe("connectCommandFor", () => {
  it("returns the official login command for Claude Code", () => {
    expect(connectCommandFor("hall.claude-code")).toBe("claude auth login");
  });

  it("returns the official login command for Codex", () => {
    expect(connectCommandFor("hall.codex")).toBe("codex login");
  });

  it("returns undefined for an adapter with no known login flow", () => {
    expect(connectCommandFor("hall.mock-agent")).toBeUndefined();
  });
});

describe("isKnownProviderAdapter", () => {
  it("is true for Claude Code and Codex", () => {
    expect(isKnownProviderAdapter("hall.claude-code")).toBe(true);
    expect(isKnownProviderAdapter("hall.codex")).toBe(true);
  });

  it("is false for Mock Agent and any unrecognized adapter", () => {
    expect(isKnownProviderAdapter("hall.mock-agent")).toBe(false);
    expect(isKnownProviderAdapter("hall.some-future-adapter")).toBe(false);
  });
});
