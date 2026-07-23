import type { TaskRequirements } from "./api-schemas";

/**
 * Phase 11 — small, named presets for the "Find suitable agent" dialog's
 * profile picker. Deliberately no `network.access` in any preset — see
 * `docs/architecture/0011-agent-capabilities-trust-and-routing.md`.
 * `custom` has no fixed `requirements`; the operator builds one by hand.
 */
export interface RequirementProfile {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly requirements?: TaskRequirements;
}

export const REQUIREMENT_PROFILES: readonly RequirementProfile[] = [
  {
    id: "implementation-isolated",
    label: "Code implementation — isolated preferred",
    description: "Real file editing, allows only sandboxed (isolated) execution.",
    requirements: {
      requiredCapabilities: ["project.read", "project.edit", "structured.events", "cancellation"],
      allowedExecutionTrust: ["isolated"],
    },
  },
  {
    id: "implementation-trusted-local-allowed",
    label: "Code implementation — trusted-local allowed",
    description:
      "Real file editing, allows sandboxed (isolated) or sandbox-bypassing (trusted-local) execution.",
    requirements: {
      requiredCapabilities: ["project.read", "project.edit", "structured.events", "cancellation"],
      allowedExecutionTrust: ["isolated", "trusted_local"],
    },
  },
  {
    id: "investigation",
    label: "Code investigation",
    description: "Reading and Git inspection only — no file edits.",
    requirements: {
      requiredCapabilities: ["project.read", "git.inspect", "structured.events"],
      allowedExecutionTrust: ["isolated", "trusted_local"],
    },
  },
  {
    id: "simulation",
    label: "Simulation / testing",
    description: "Deterministic simulation only — no real provider execution.",
    requirements: {
      requiredCapabilities: ["structured.events", "cancellation"],
      allowedExecutionTrust: ["simulated"],
    },
  },
  {
    id: "custom",
    label: "Custom",
    description: "Choose capabilities and allowed execution trust manually.",
  },
];
