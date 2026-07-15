import { z } from "zod";
import { boundedNonBlankString, parseWithSchema } from "@hall-of-wisdom/protocol";

/**
 * Which deterministic scenario a `MockAgentAdapter` instance simulates.
 * `"cancellable"` behaves identically to `"success"` unless the run is
 * actually cancelled mid-execution — it exists purely as an intent label
 * for tests that plan to call `cancel()` partway through, giving them a
 * scenario with a predictable number of progress steps to cancel within.
 */
export const mockAgentScenarioSchema = z.enum(["success", "failure", "cancellable"]);
export type MockAgentScenario = z.infer<typeof mockAgentScenarioSchema>;

/**
 * Configuration for a `MockAgentAdapter` instance. All values are bounded
 * and validated at construction time (the trust boundary), so an invalid
 * configuration fails loudly immediately rather than producing strange
 * behavior partway through a run.
 */
export const mockAgentConfigSchema = z
  .object({
    scenario: mockAgentScenarioSchema.default("success"),
    progressMessageCount: z
      .number()
      .int()
      .min(0, "must not be negative")
      .max(20, "must not exceed 20 progress messages")
      .default(2),
    stepDelayMs: z
      .number()
      .int()
      .min(0, "must not be negative")
      .max(5000, "must not exceed 5000ms")
      .default(0),
    failureRetryable: z.boolean().default(false),
    completionSummary: boundedNonBlankString(2000).optional(),
  })
  .strict();

export type MockAgentConfig = z.infer<typeof mockAgentConfigSchema>;
export type MockAgentConfigInput = z.input<typeof mockAgentConfigSchema>;

export function parseMockAgentConfig(input: unknown): MockAgentConfig {
  return parseWithSchema(mockAgentConfigSchema, input, "MockAgentConfig");
}
