import {
  parseAgentAdapterDescriptor,
  type AgentAdapterDescriptor,
} from "@hall-of-wisdom/agent-adapter-sdk";

export const HERMES_ROUTER_ADAPTER_ID = "hall.hermes-router";
export const HERMES_ROUTER_AGENT_ID = "hermes-router";
export const HERMES_ROUTER_ADAPTER_VERSION = "0.1.0";

export const HERMES_RUNTIME_CAPABILITIES = [
  "project.read",
  "project.edit",
  "command.execute",
  "structured.events",
  "cancellation",
] as const;

export const hermesRouterDescriptor: AgentAdapterDescriptor = parseAgentAdapterDescriptor({
  adapterId: HERMES_ROUTER_ADAPTER_ID,
  displayName: "Hermes Router",
  adapterVersion: HERMES_ROUTER_ADAPTER_VERSION,
  supportedAgent: {
    agentId: HERMES_ROUTER_AGENT_ID,
    displayName: "Hermes Coding Runtime",
    adapterId: HERMES_ROUTER_ADAPTER_ID,
    adapterVersion: HERMES_ROUTER_ADAPTER_VERSION,
  },
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
  declaredCapabilities: HERMES_RUNTIME_CAPABILITIES,
  integrationLevel: "structured_cli",
  supportedOperatingSystems: ["windows", "macos", "linux"],
});
