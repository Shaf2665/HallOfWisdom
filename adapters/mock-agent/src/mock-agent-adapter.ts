import {
  parseAgentDetectionResult,
  parseAgentTaskInput,
  type AgentAdapter,
  type AgentDetectionResult,
  type AgentExecutionOptions,
  type AgentRunHandle,
  type AgentTaskInput,
} from "@hall-of-wisdom/agent-adapter-sdk";
import { mockAgentDescriptor, MOCK_AGENT_VERSION } from "./descriptor.js";
import { parseMockAgentConfig, type MockAgentConfigInput } from "./config.js";
import { MockAgentRun } from "./mock-agent-run.js";

/**
 * Deterministic, local-only, network-free `AgentAdapter` implementation.
 * Configuration (which scenario to simulate, how many progress steps,
 * timing, etc.) is fixed per adapter instance rather than accepted on each
 * `startTask` call: the generic SDK contract (`AgentTaskInput`,
 * `AgentExecutionOptions`) is intentionally provider-neutral and has no
 * "mock scenario" concept, so Mock-Agent-specific configuration lives on
 * the adapter itself. Tests that need a different scenario construct a
 * new `MockAgentAdapter` with a different config.
 */
export class MockAgentAdapter implements AgentAdapter {
  readonly descriptor = mockAgentDescriptor;
  readonly #config;

  constructor(config: MockAgentConfigInput = {}) {
    this.#config = parseMockAgentConfig(config);
  }

  detect(): Promise<AgentDetectionResult> {
    return Promise.resolve(
      parseAgentDetectionResult({
        installed: true,
        availability: "available",
        detectedVersion: MOCK_AGENT_VERSION,
      }),
    );
  }

  startTask(input: AgentTaskInput, options?: AgentExecutionOptions): Promise<AgentRunHandle> {
    const parsedInput = parseAgentTaskInput(input);
    const run = new MockAgentRun(parsedInput, this.#config, options?.signal);
    return Promise.resolve(run);
  }
}
