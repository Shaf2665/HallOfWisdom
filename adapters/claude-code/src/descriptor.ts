import {
  parseAgentAdapterDescriptor,
  type AgentAdapterDescriptor,
} from "@hall-of-wisdom/agent-adapter-sdk";

export const CLAUDE_CODE_ADAPTER_ID = "hall.claude-code";
export const CLAUDE_CODE_AGENT_ID = "claude-code";
export const CLAUDE_CODE_ADAPTER_VERSION = "0.1.0";

/**
 * Parsed through the SDK's own `parseAgentAdapterDescriptor` at module load
 * time, same discipline as `mockAgentDescriptor`. `adapterVersion` is this
 * adapter package's own version, not the installed Claude Code CLI's
 * version — the latter is only ever reported through `detect()`'s
 * `detectedVersion` field, since it varies per machine.
 *
 * `sessionResume` is deliberately `false` for Phase 9: the installed CLI
 * does support `--resume`, but this adapter does not wire session
 * resumption in this phase (see `docs/architecture/0008-claude-code-adapter.md`,
 * "Session policy") — the capability flag reflects what this adapter
 * actually does, not what the underlying CLI is capable of in principle.
 */
export const claudeCodeDescriptor: AgentAdapterDescriptor = parseAgentAdapterDescriptor({
  adapterId: CLAUDE_CODE_ADAPTER_ID,
  displayName: "Claude Code",
  adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
  supportedAgent: {
    agentId: CLAUDE_CODE_AGENT_ID,
    displayName: "Claude Code",
    adapterId: CLAUDE_CODE_ADAPTER_ID,
    adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
    provider: "Anthropic",
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
  // Phase 11 — static declaration of what this adapter was designed to
  // support; `detect()`'s `capabilityObservations` report what's actually
  // verified on the current machine, gated by this declaration.
  //
  // `vision.image` is declared but — see `detection.ts` — never reported
  // `verified`: the installed CLI has no `--image`/multimodal input flag
  // (confirmed live against `claude --help`), so the only path an
  // attached image reaches this adapter is its normal `Read` tool
  // (already in the fixed `--allowedTools` list, and Claude models are
  // multimodal), which is plausible but has never been proven end-to-end.
  // `declared` keeps this legitimately in the catalog without letting
  // routing ever pick this adapter for work that requires verified vision.
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
