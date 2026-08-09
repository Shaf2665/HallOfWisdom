import {
  parseAgentTaskInput,
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
  resolveHermesRuntimeConfiguration,
  type FileSystemProbe,
} from "./detection.js";
import { startHermesExecutionTransport } from "./execution-transport.js";
import { HermesRun, type HermesExecutionTransportStarter } from "./hermes-run.js";
import { buildHermesTaskPrompt } from "./prompt-builder.js";
import type { DetectionProcessRunner } from "./process-runner.js";

export interface HermesRouterAdapterConfig {
  readonly platform?: NodeJS.Platform;
  readonly parentEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly fs?: FileSystemProbe;
  readonly processRunner?: DetectionProcessRunner;
  readonly startTransport?: HermesExecutionTransportStarter;
}

export class HermesRouterAdapter implements AgentAdapter {
  readonly descriptor = hermesRouterDescriptor;

  readonly #detectionOptions: ReturnType<typeof createDefaultHermesDetectionOptions>;
  readonly #startTransport: HermesExecutionTransportStarter;

  constructor(config: HermesRouterAdapterConfig = {}) {
    this.#detectionOptions = createDefaultHermesDetectionOptions(config);
    this.#startTransport = config.startTransport ?? startHermesExecutionTransport;
  }

  detect(): Promise<AgentDetectionResult> {
    return detectHermesRouter(this.#detectionOptions);
  }

  startTask(input: AgentTaskInput, options?: AgentExecutionOptions): Promise<AgentRunHandle> {
    const parsedInput = parseAgentTaskInput(input);
    if (parsedInput.sessionId !== undefined) {
      return Promise.reject(
        new Error(
          "The Hermes Router adapter does not support session resumption; sessionId must not be provided.",
        ),
      );
    }

    const configuration = resolveHermesRuntimeConfiguration(this.#detectionOptions);
    const prompt = buildHermesTaskPrompt({
      title: parsedInput.hallTask.title,
      description: parsedInput.hallTask.description,
    });

    return Promise.resolve(
      new HermesRun({
        pythonExecutable: configuration.ok ? configuration.pythonExecutable : "",
        runnerPath: configuration.ok ? configuration.runnerPath : "",
        workingDirectory: parsedInput.workingDirectory,
        env: this.#detectionOptions.parentEnv,
        prompt,
        runId: parsedInput.runId,
        platform: this.#detectionOptions.platform,
        taskId: parsedInput.hallTask.taskId,
        agentId: parsedInput.agentIdentity.agentId,
        startTransport: this.#startTransport,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  }
}
