import {
  parseAgentAdapterDescriptor,
  type AgentAdapterDescriptor,
} from "@hall-of-wisdom/agent-adapter-sdk";

export const CODEX_ADAPTER_ID = "hall.codex";
export const CODEX_AGENT_ID = "codex";
export const CODEX_ADAPTER_VERSION = "0.1.0";

/**
 * Parsed through the SDK's own `parseAgentAdapterDescriptor` at module
 * load time, same discipline as `claudeCodeDescriptor`. `adapterVersion`
 * is this adapter package's own version, not the installed Codex CLI's
 * version — the latter is only ever reported through `detect()`'s
 * `detectedVersion` field, since it varies per machine.
 *
 * `sessionResume` is `false`: this adapter never uses `codex exec
 * resume`. `mcp` is `false`: no MCP server is ever configured or
 * launched, regardless of what a project's own configuration requests.
 */
export const codexDescriptor: AgentAdapterDescriptor = parseAgentAdapterDescriptor({
  adapterId: CODEX_ADAPTER_ID,
  displayName: "Codex",
  adapterVersion: CODEX_ADAPTER_VERSION,
  supportedAgent: {
    agentId: CODEX_AGENT_ID,
    displayName: "Codex",
    adapterId: CODEX_ADAPTER_ID,
    adapterVersion: CODEX_ADAPTER_VERSION,
    provider: "OpenAI",
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
  // Phase 11 — static declaration; no `session.resume` (this adapter
  // never uses `codex exec resume`) and no `network.access` (never
  // offered to a task through this adapter). What's actually verified on
  // this machine right now is `detect()`'s `capabilityObservations` job.
  // `vision.image` is declared because the installed CLI's `codex exec
  // --help` genuinely exposes `-i, --image <FILE>...` — whether it is
  // ever reported `verified` still depends on a live flag-support probe
  // in `detection.ts`, same discipline as every other capability here.
  declaredCapabilities: [
    "project.read",
    "project.edit",
    "command.execute",
    "git.inspect",
    "structured.events",
    "cancellation",
    "vision.image",
  ],
  integrationLevel: "structured_cli",
  supportedOperatingSystems: ["windows", "macos", "linux"],
});
