import { z } from "zod";
import { parseWithSchema } from "./errors.js";

/**
 * Every capability is a required boolean rather than an optional one, so
 * an adapter must state explicitly what it supports instead of a missing
 * field being silently interpreted as "unsupported" or "supported".
 */
export const agentCapabilitiesSchema = z
  .object({
    streaming: z.boolean(),
    cancellation: z.boolean(),
    sessionResume: z.boolean(),
    toolEvents: z.boolean(),
    fileEditing: z.boolean(),
    shellExecution: z.boolean(),
    subagents: z.boolean(),
    mcp: z.boolean(),
    acp: z.boolean(),
  })
  .strict();

export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

export function parseAgentCapabilities(input: unknown): AgentCapabilities {
  return parseWithSchema(agentCapabilitiesSchema, input, "AgentCapabilities");
}
