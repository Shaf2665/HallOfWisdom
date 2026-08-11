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
  HERMES_EXECUTION_DISABLED_MESSAGE,
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
  readonly environmentProvider?: (() => Readonly<NodeJS.ProcessEnv>) | undefined;
  readonly fs?: FileSystemProbe;
  readonly processRunner?: DetectionProcessRunner;
  readonly startTransport?: HermesExecutionTransportStarter;
  readonly isolatedExecutionEnabled?: boolean;
}

export class HermesRouterAdapter implements AgentAdapter {
  readonly descriptor = hermesRouterDescriptor;

  readonly #detectionOptions: ReturnType<typeof createDefaultHermesDetectionOptions>;
  readonly #startTransport: HermesExecutionTransportStarter;
  readonly #isolatedExecutionEnabled: boolean;
  readonly #environmentProvider: () => Readonly<NodeJS.ProcessEnv>;

  constructor(config: HermesRouterAdapterConfig = {}) {
    this.#detectionOptions = createDefaultHermesDetectionOptions(config);
    this.#environmentProvider =
      config.environmentProvider ?? (() => this.#detectionOptions.parentEnv);
    this.#startTransport = config.startTransport ?? startHermesExecutionTransport;
    this.#isolatedExecutionEnabled = config.isolatedExecutionEnabled ?? false;
  }

  detect(): Promise<AgentDetectionResult> {
    return detectHermesRouter({
      ...this.#detectionOptions,
      parentEnv: this.#environmentProvider(),
    });
  }

  startTask(input: AgentTaskInput, options?: AgentExecutionOptions): Promise<AgentRunHandle> {
    if (!this.#isolatedExecutionEnabled) {
      return Promise.reject(new Error(HERMES_EXECUTION_DISABLED_MESSAGE));
    }
    const parsedInput = parseAgentTaskInput(input);
    if (parsedInput.sessionId !== undefined) {
      return Promise.reject(
        new Error(
          "The Hermes Router adapter does not support session resumption; sessionId must not be provided.",
        ),
      );
    }

    const parentEnv = this.#environmentProvider();
    const configuration = resolveHermesRuntimeConfiguration({
      ...this.#detectionOptions,
      parentEnv,
    });
    const prompt = buildHermesTaskPrompt({
      title: parsedInput.hallTask.title,
      description: parsedInput.hallTask.description,
    });

    return Promise.resolve(
      new HermesRun({
        pythonExecutable: configuration.ok ? configuration.pythonExecutable : "",
        runnerPath: configuration.ok ? configuration.runnerPath : "",
        workingDirectory: parsedInput.workingDirectory,
        env: parentEnv,
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
