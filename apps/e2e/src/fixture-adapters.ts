import type {
  AgentAdapter,
  AgentAdapterDescriptor,
  AgentDetectionResult,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { CapabilityObservation } from "@hall-of-wisdom/protocol";

/**
 * Deterministic, fixture `AgentAdapter` implementations for Playwright
 * E2E verification only — never used by any production composition path
 * (`server.ts`/`server-composition.ts` never import this module). Every
 * `detect()` result below is fixed and immediate: no real `claude`/`codex`
 * process is ever spawned, and no subscription usage is ever spent. Every
 * `startTask()` rejects — this fixture set exists to verify the
 * capability/trust/routing/assignment *UI and API surface*, not to run a
 * real or simulated task; the Playwright suite never clicks "Start".
 *
 * The fixed detection results below intentionally mirror the exact
 * "CURRENT VERIFIED ADAPTER STATE" shape real adapters report on a
 * correctly configured machine (see
 * `docs/architecture/0011-agent-capabilities-trust-and-routing.md`), so
 * the E2E suite exercises genuinely representative data, not arbitrary
 * placeholder values.
 */

const IMPLEMENTATION_CAPABILITIES: readonly CapabilityObservation[] = [
  {
    capability: "project.read",
    status: "verified",
    safeSummary: "Verified by a Phase 11 E2E fixture.",
    evidence: "deterministic_test",
  },
  {
    capability: "project.edit",
    status: "verified",
    safeSummary: "Verified by a Phase 11 E2E fixture.",
    evidence: "deterministic_test",
  },
  {
    capability: "structured.events",
    status: "verified",
    safeSummary: "Verified by a Phase 11 E2E fixture.",
    evidence: "deterministic_test",
  },
  {
    capability: "cancellation",
    status: "verified",
    safeSummary: "Verified by a Phase 11 E2E fixture.",
    evidence: "deterministic_test",
  },
];

function buildDescriptor(
  adapterId: string,
  displayName: string,
  agentId: string,
): AgentAdapterDescriptor {
  return {
    adapterId,
    displayName,
    adapterVersion: "0.0.0-e2e-fixture",
    integrationLevel: adapterId === "hall.mock-agent" ? "native" : "structured_cli",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    supportedAgent: {
      agentId,
      displayName,
      adapterId,
      adapterVersion: "0.0.0-e2e-fixture",
    },
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
      toolEvents: true,
      fileEditing: adapterId !== "hall.mock-agent",
      shellExecution: adapterId !== "hall.mock-agent",
      subagents: false,
      mcp: false,
      acp: false,
    },
    declaredCapabilities:
      adapterId === "hall.mock-agent"
        ? ["structured.events", "cancellation"]
        : [
            "project.read",
            "project.edit",
            "command.execute",
            "git.inspect",
            "structured.events",
            "cancellation",
          ],
  };
}

function buildFixtureAdapter(
  descriptor: AgentAdapterDescriptor,
  detection: AgentDetectionResult,
): AgentAdapter {
  return {
    descriptor,
    detect(): Promise<AgentDetectionResult> {
      return Promise.resolve(detection);
    },
    startTask(): Promise<never> {
      return Promise.reject(
        new Error(
          `${descriptor.adapterId}.startTask must never be called — this is a Phase 11 E2E fixture, not a real adapter.`,
        ),
      );
    },
  };
}

export function createFixtureMockAgentAdapter(): AgentAdapter {
  return buildFixtureAdapter(buildDescriptor("hall.mock-agent", "Mock Agent", "mock-agent"), {
    installed: true,
    availability: "available",
    executionTrust: "simulated",
    capabilityObservations: [
      {
        capability: "structured.events",
        status: "verified",
        safeSummary: "Verified by a Phase 11 E2E fixture.",
        evidence: "deterministic_test",
      },
      {
        capability: "cancellation",
        status: "verified",
        safeSummary: "Verified by a Phase 11 E2E fixture.",
        evidence: "deterministic_test",
      },
    ],
    limitations: ["Simulated execution only — no real filesystem or process changes."],
  });
}

export function createFixtureClaudeCodeAdapter(): AgentAdapter {
  return buildFixtureAdapter(buildDescriptor("hall.claude-code", "Claude Code", "claude-code"), {
    installed: true,
    availability: "available",
    executionTrust: "isolated",
    capabilityObservations: [...IMPLEMENTATION_CAPABILITIES],
    limitations: [
      "Runs in this adapter's fixed --safe-mode profile; no discretionary --setting-sources are passed.",
    ],
    diagnosticMessage: "Claude Code is installed and authenticated with a Claude subscription.",
  });
}

export function createFixtureCodexAdapter(): AgentAdapter {
  return buildFixtureAdapter(buildDescriptor("hall.codex", "Codex", "codex"), {
    installed: true,
    availability: "available",
    executionTrust: "trusted_local",
    capabilityObservations: [...IMPLEMENTATION_CAPABILITIES],
    limitations: [
      "Trusted-local mode: Codex sandbox and approval protections are bypassed. Codex runs with the Hall Core user's filesystem permissions.",
    ],
    diagnosticMessage:
      "Trusted-local mode: Codex sandbox and approval protections are bypassed. Codex runs with the Hall Core user's filesystem permissions.",
  });
}

export function createAllFixtureAdapters(): readonly AgentAdapter[] {
  return [
    createFixtureMockAgentAdapter(),
    createFixtureClaudeCodeAdapter(),
    createFixtureCodexAdapter(),
  ];
}
