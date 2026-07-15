import { z } from "zod";
import {
  agentCapabilitiesSchema,
  agentIdentitySchema,
  boundedNonBlankString,
  nonEmptyIdSchema,
  parseWithSchema,
} from "@hall-of-wisdom/protocol";

/**
 * How deeply an adapter integrates with its underlying coding agent, from
 * a first-class API (`native`) down to no viable integration at all
 * (`unsupported`). This is descriptive metadata only — Hall Runner uses it
 * to decide how to invoke the adapter, but this package does not change
 * behavior based on it.
 */
export const integrationLevelSchema = z.enum([
  "native",
  "structured_cli",
  "interactive_cli",
  "ide_bridge",
  "restricted",
  "unsupported",
]);
export type IntegrationLevel = z.infer<typeof integrationLevelSchema>;

export const operatingSystemSchema = z.enum(["windows", "macos", "linux"]);
export type OperatingSystem = z.infer<typeof operatingSystemSchema>;

/**
 * Static, provider-neutral description of an adapter. This is pure
 * declared metadata — it does not perform runtime platform detection.
 * Runtime detection (is this OS actually running, is the executable
 * actually installed) is `AgentAdapter.detect()`'s job, not this shape's.
 */
export const agentAdapterDescriptorSchema = z
  .object({
    adapterId: nonEmptyIdSchema,
    displayName: boundedNonBlankString(200),
    adapterVersion: boundedNonBlankString(64),
    supportedAgent: agentIdentitySchema,
    capabilities: agentCapabilitiesSchema,
    integrationLevel: integrationLevelSchema,
    supportedOperatingSystems: z
      .array(operatingSystemSchema)
      .min(1, "must declare at least one supported operating system")
      .max(3, "must not exceed the 3 known operating systems")
      .refine(
        (values: OperatingSystem[]) => new Set(values).size === values.length,
        "must not list the same operating system more than once",
      ),
  })
  .strict();

export type AgentAdapterDescriptor = z.infer<typeof agentAdapterDescriptorSchema>;

export function parseAgentAdapterDescriptor(input: unknown): AgentAdapterDescriptor {
  return parseWithSchema(agentAdapterDescriptorSchema, input, "AgentAdapterDescriptor");
}
