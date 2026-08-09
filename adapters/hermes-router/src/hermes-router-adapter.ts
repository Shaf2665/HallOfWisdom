import {
  InvalidAdapterStateError,
  type AgentAdapter,
  type AgentDetectionResult,
  type AgentExecutionOptions,
  type AgentRunHandle,
  type AgentTaskInput,
} from "@hall-of-wisdom/agent-adapter-sdk";
import { hermesRouterDescriptor } from "./descriptor.js";
import {
  createDefaultHermesDetectionOptions,
  detectHermesRouter,
  type FileSystemProbe,
} from "./detection.js";
import type { DetectionProcessRunner } from "./process-runner.js";

export const HERMES_EXECUTION_NOT_IMPLEMENTED_MESSAGE =
  "Hermes execution transport is not implemented yet.";

export interface HermesRouterAdapterConfig {
  readonly platform?: NodeJS.Platform;
  readonly parentEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly fs?: FileSystemProbe;
  readonly processRunner?: DetectionProcessRunner;
}

export class HermesRouterAdapter implements AgentAdapter {
  readonly descriptor = hermesRouterDescriptor;

  readonly #detectionOptions: ReturnType<typeof createDefaultHermesDetectionOptions>;

  constructor(config: HermesRouterAdapterConfig = {}) {
    this.#detectionOptions = createDefaultHermesDetectionOptions(config);
  }

  detect(): Promise<AgentDetectionResult> {
    return detectHermesRouter(this.#detectionOptions);
  }

  startTask(_input: AgentTaskInput, _options?: AgentExecutionOptions): Promise<AgentRunHandle> {
    return Promise.reject(new InvalidAdapterStateError(HERMES_EXECUTION_NOT_IMPLEMENTED_MESSAGE));
  }
}
