import { z } from "zod";
import { boundedNonBlankString, nonEmptyIdSchema } from "./ids.js";
import { parseWithSchema } from "./errors.js";

export const agentIdentitySchema = z
  .object({
    agentId: nonEmptyIdSchema,
    displayName: boundedNonBlankString(200),
    adapterId: nonEmptyIdSchema,
    adapterVersion: boundedNonBlankString(64),
    provider: boundedNonBlankString(100).optional(),
  })
  .strict();

export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

export function parseAgentIdentity(input: unknown): AgentIdentity {
  return parseWithSchema(agentIdentitySchema, input, "AgentIdentity");
}
