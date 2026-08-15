import {
  parseAgentDetectionResult,
  parseAgentTaskInput,
  EventFactory,
  TerminalEventGuard,
  type AgentAdapter,
  type AgentDetectionResult,
  type AgentExecutionOptions,
  type AgentRunHandle,
  type AgentTaskInput,
  type RunTerminalState,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { claudeCodeDescriptor } from "./descriptor.js";
import { detectClaudeCode } from "./detection.js";
import { resolveClaudeExecutable, type FileSystemProbe } from "./executable-resolver.js";
import { realFileSystemProbe } from "./real-file-system-probe.js";
import { buildChildEnvironment } from "./environment.js";
import { buildTaskPrompt } from "./prompt-builder.js";
import { buildClaudeArgv } from "./permission-profile.js";
import { nodeProcessSpawner, type ProcessSpawner } from "./process-spawner.js";
import { ClaudeCodeRun } from "./claude-code-run.js";
import {
  buildFailure,
  CLAUDE_CLI_NOT_FOUND,
  CLAUDE_NOT_AUTHENTICATED,
  CLAUDE_SUBSCRIPTION_AUTH_UNVERIFIED,
} from "./failure-codes.js";
import { getEnvValueCaseInsensitive } from "./env-lookup.js";

export interface ClaudeCodeAdapterConfig {
  readonly platform?: NodeJS.Platform;
  readonly parentEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly spawner?: ProcessSpawner;
  readonly fs?: FileSystemProbe;
  readonly binaryName?: string;
}

/**
 * Immediately-failed run handle for the one case where `startTask` must
 * refuse to spawn anything at all: subscription authentication could not
 * be re-verified at start time (see `#assertSubscriptionAuthenticated`
 * below). Never emits `run.started` — nothing started — only a single
 * `run.failed`, built through the same `EventFactory`/`TerminalEventGuard`
 * discipline every other event in this adapter uses.
 */
class PreflightFailedRun implements AgentRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<NormalizedAgentEvent>;
  readonly completion: Promise<NormalizedAgentEvent>;

  constructor(
    runId: string,
    taskId: string,
    agentId: string,
    failure: ReturnType<typeof buildFailure>,
  ) {
    this.runId = runId;
    const factory = new EventFactory({ runId, taskId, agentId });
    const guard = new TerminalEventGuard();
    const event = guard.guardEvent(factory.runFailed(failure));
    this.completion = Promise.resolve(event);
    this.events = {
      [Symbol.asyncIterator]() {
        let yielded = false;
        return {
          next(): Promise<IteratorResult<NormalizedAgentEvent>> {
            if (yielded) return Promise.resolve({ value: undefined, done: true });
            yielded = true;
            return Promise.resolve({ value: event, done: false });
          },
        };
      },
    };
  }

  readonly currentState: RunTerminalState = "failed";

  cancel(): void {
    // Already terminal the moment this object exists; nothing to cancel.
  }
}

/**
 * Executes the locally installed, subscription-authenticated Claude Code
 * CLI. See `docs/architecture/0008-claude-code-adapter.md` for the full
 * design: subscription-auth verification, environment sanitization,
 * executable resolution, the fixed permission profile, prompt
 * construction, the stream-json parser boundary, event mapping, and
 * process-tree cancellation.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly descriptor = claudeCodeDescriptor;

  readonly #platform: NodeJS.Platform;
  readonly #parentEnv: Readonly<NodeJS.ProcessEnv>;
  readonly #spawner: ProcessSpawner;
  readonly #fs: FileSystemProbe;
  readonly #binaryName: string | undefined;

  constructor(config: ClaudeCodeAdapterConfig = {}) {
    this.#platform = config.platform ?? process.platform;
    this.#parentEnv = config.parentEnv ?? process.env;
    this.#spawner = config.spawner ?? nodeProcessSpawner;
    this.#fs = config.fs ?? realFileSystemProbe;
    this.#binaryName = config.binaryName;
  }

  async detect(): Promise<AgentDetectionResult> {
    const result = await detectClaudeCode({
      platform: this.#platform,
      parentEnv: this.#parentEnv,
      fs: this.#fs,
      spawner: this.#spawner,
      ...(this.#binaryName !== undefined ? { binaryName: this.#binaryName } : {}),
    });
    return parseAgentDetectionResult(result);
  }

  async startTask(input: AgentTaskInput, options?: AgentExecutionOptions): Promise<AgentRunHandle> {
    const parsedInput = parseAgentTaskInput(input);

    // Phase 9 policy B (see docs/architecture/0008-claude-code-adapter.md,
    // "Session policy"): session resumption is not supported. A caller
    // that supplies a sessionId anyway gets an explicit rejection, never
    // a silently-ignored field and a quietly-fresh session.
    if (parsedInput.sessionId !== undefined) {
      throw new Error(
        "The Claude Code adapter does not support session resumption in this phase; sessionId must not be provided.",
      );
    }

    // Billing-safety defense in depth: re-verify subscription
    // authentication at the moment of execution, not only whenever the
    // caller last called detect(). See docs/architecture/0008-claude-code-adapter.md,
    // "Why detection and execution share one sanitized environment" and
    // "Authentication precedence risk".
    const detection = await this.detect();
    if (detection.availability !== "available") {
      return new PreflightFailedRun(
        parsedInput.runId,
        parsedInput.hallTask.taskId,
        parsedInput.agentIdentity.agentId,
        buildFailure(
          failureCodeForUnavailableDetection(detection),
          safeUnavailableMessage(detection),
        ),
      );
    }

    const pathExt = getEnvValueCaseInsensitive(this.#parentEnv, "PATHEXT");
    const resolution = resolveClaudeExecutable({
      platform: this.#platform,
      pathValue: getEnvValueCaseInsensitive(this.#parentEnv, "PATH") ?? "",
      ...(pathExt !== undefined ? { pathExt } : {}),
      fs: this.#fs,
      ...(this.#binaryName !== undefined ? { binaryName: this.#binaryName } : {}),
    });
    if (!resolution.found || resolution.executable?.kind !== "native") {
      return new PreflightFailedRun(
        parsedInput.runId,
        parsedInput.hallTask.taskId,
        parsedInput.agentIdentity.agentId,
        buildFailure(
          CLAUDE_CLI_NOT_FOUND,
          "Claude Code CLI could not be resolved to a native executable.",
        ),
      );
    }

    const prompt = buildTaskPrompt({
      title: parsedInput.hallTask.title,
      description: parsedInput.hallTask.description,
      priority: parsedInput.hallTask.priority,
      projectId: parsedInput.hallTask.projectId,
      attachments: parsedInput.attachments?.map((attachment) => ({
        relativePath: attachment.relativePath,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
      })),
    });

    const run = new ClaudeCodeRun({
      executablePath: resolution.executable.path,
      args: buildClaudeArgv(prompt),
      workingDirectory: parsedInput.workingDirectory,
      env: buildChildEnvironment(this.#parentEnv),
      spawner: this.#spawner,
      platform: this.#platform,
      runId: parsedInput.runId,
      taskId: parsedInput.hallTask.taskId,
      agentId: parsedInput.agentIdentity.agentId,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
    return Promise.resolve(run);
  }
}

function failureCodeForUnavailableDetection(detection: AgentDetectionResult): string {
  switch (detection.availability) {
    case "unavailable":
      return CLAUDE_CLI_NOT_FOUND;
    case "logged_out":
      return CLAUDE_NOT_AUTHENTICATED;
    default:
      return CLAUDE_SUBSCRIPTION_AUTH_UNVERIFIED;
  }
}

function safeUnavailableMessage(detection: AgentDetectionResult): string {
  return (
    detection.diagnosticMessage ?? "Claude Code is not currently available to execute this task."
  );
}
