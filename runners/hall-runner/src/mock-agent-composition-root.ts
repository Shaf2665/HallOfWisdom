import {
  MockAgentAdapter,
  mockAgentScenarioSchema,
  type MockAgentScenario,
} from "@hall-of-wisdom/mock-agent";
import { AgentRegistry } from "./agent-registry.js";
import { InvalidCliInputError } from "./errors.js";
import type { CliOptions } from "./cli-args.js";

/**
 * The only file in this package allowed to know about Mock Agent
 * specifically. It converts validated, generic CLI options into typed
 * `MockAgentConfig`, constructs the adapter, and registers it — the
 * generic runner service (`runner-service.ts`) never sees a scenario
 * name or a `MockAgentAdapter` type, only the `AgentAdapter` interface.
 */
export function createMockAgentRegistry(
  options: Pick<CliOptions, "scenario" | "stepDelayMs">,
): AgentRegistry {
  const adapter = new MockAgentAdapter({
    scenario: resolveScenario(options.scenario),
    stepDelayMs: options.stepDelayMs,
  });
  const registry = new AgentRegistry();
  registry.register(adapter);
  return registry;
}

function resolveScenario(rawScenario: string | undefined): MockAgentScenario {
  const value = rawScenario ?? "success";
  const result = mockAgentScenarioSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidCliInputError(
      `--scenario must be one of "success", "failure", "cancellable", got "${value}"`,
    );
  }
  return result.data;
}
