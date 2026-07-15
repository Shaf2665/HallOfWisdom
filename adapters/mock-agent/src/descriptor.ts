import {
  parseAgentAdapterDescriptor,
  type AgentAdapterDescriptor,
} from "@hall-of-wisdom/agent-adapter-sdk";

export const MOCK_AGENT_ADAPTER_ID = "hall.mock-agent";
export const MOCK_AGENT_ID = "mock-agent";
export const MOCK_AGENT_VERSION = "0.1.0";

/**
 * Parsed through the SDK's own `parseAgentAdapterDescriptor` at module load
 * time so this descriptor is validated the same way any other adapter's
 * descriptor would be — including that its declared capabilities are
 * exactly the booleans the Mock Agent actually implements: it streams
 * events and supports cancellation and tool events, but it does not edit
 * files, run shell commands, resume sessions, or support subagents, MCP,
 * or ACP.
 */
export const mockAgentDescriptor: AgentAdapterDescriptor = parseAgentAdapterDescriptor({
  adapterId: MOCK_AGENT_ADAPTER_ID,
  displayName: "Mock Agent",
  adapterVersion: MOCK_AGENT_VERSION,
  supportedAgent: {
    agentId: MOCK_AGENT_ID,
    displayName: "Mock Agent",
    adapterId: MOCK_AGENT_ADAPTER_ID,
    adapterVersion: MOCK_AGENT_VERSION,
  },
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
  integrationLevel: "native",
  supportedOperatingSystems: ["windows", "macos", "linux"],
});
