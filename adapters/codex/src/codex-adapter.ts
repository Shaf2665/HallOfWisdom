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
import { codexDescriptor } from "./descriptor.js";
import {
  detectCodex,
  UNSUPPORTED_ISOLATION_PROFILE_MESSAGE,
  UNVERIFIED_EXECUTION_CAPABILITY_MESSAGE,
} from "./detection.js";
import { resolveCodexExecutable, type FileSystemProbe } from "./executable-resolver.js";
import { realFileSystemProbe } from "./real-file-system-probe.js";
import { buildChildEnvironment } from "./environment.js";
import { buildCodexTaskPrompt } from "./prompt-builder.js";
import { buildCodexArgv } from "./permission-profile.js";
import {
  isInsideGitRepository,
  realGitRepositoryProbe,
  type GitRepositoryProbe,
} from "./git-repository-check.js";
import { nodeProcessSpawner, type ProcessSpawner } from "./process-spawner.js";
import { CodexRun } from "./codex-run.js";
import {
  buildFailure,
  CODEX_CLI_NOT_FOUND,
  CODEX_GIT_REPOSITORY_REQUIRED,
  CODEX_NOT_AUTHENTICATED,
  CODEX_CHATGPT_AUTH_UNVERIFIED,
  CODEX_ISOLATION_UNSUPPORTED,
} from "./failure-codes.js";
import { getEnvValueCaseInsensitive } from "./env-lookup.js";

export interface CodexAdapterConfig {
  readonly platform?: NodeJS.Platform;
  readonly parentEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly spawner?: ProcessSpawner;
  readonly fs?: FileSystemProbe;
  readonly gitProbe?: GitRepositoryProbe;
  readonly binaryName?: string;
}

/**
 * Immediately-failed run handle for the cases where `startTask` must
 * refuse to spawn anything at all — ChatGPT authentication could not be
 * re-verified at start time, the executable could not be resolved, or the
 * working directory is not a Git repository. Never emits `run.started` —
 * nothing started — only a single `run.failed`, built through the same
 * `EventFactory`/`TerminalEventGuard` discipline every other event in
 * this adapter uses. Mirrors the Claude Code adapter's
 * `PreflightFailedRun`.
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
 * Executes the locally installed, ChatGPT-authenticated Codex CLI. See
 * `docs/architecture/0009-codex-adapter.md` for the full design:
 * ChatGPT-auth verification, environment sanitization, executable
 * resolution (including the Windows `.cmd` shim path), the fixed sandbox
 * profile, prompt construction, the JSONL parser boundary, event mapping,
 * and process-tree cancellation.
 */
export class CodexAdapter implements AgentAdapter {
  readonly descriptor = codexDescriptor;

  readonly #platform: NodeJS.Platform;
  readonly #parentEnv: Readonly<NodeJS.ProcessEnv>;
  readonly #spawner: ProcessSpawner;
  readonly #fs: FileSystemProbe;
  readonly #gitProbe: GitRepositoryProbe;
  readonly #binaryName: string | undefined;

  constructor(config: CodexAdapterConfig = {}) {
    this.#platform = config.platform ?? process.platform;
    this.#parentEnv = config.parentEnv ?? process.env;
    this.#spawner = config.spawner ?? nodeProcessSpawner;
    this.#fs = config.fs ?? realFileSystemProbe;
    this.#gitProbe = config.gitProbe ?? realGitRepositoryProbe;
    this.#binaryName = config.binaryName;
  }

  async detect(): Promise<AgentDetectionResult> {
    const result = await detectCodex({
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

    if (parsedInput.sessionId !== undefined) {
      throw new Error(
        "The Codex adapter does not support session resumption; sessionId must not be provided.",
      );
    }

    // Billing-safety defense in depth: re-verify ChatGPT authentication at
    // the moment of execution, not only whenever the caller last called
    // detect(). Mirrors the Claude Code adapter's own discipline.
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
    const resolution = resolveCodexExecutable({
      platform: this.#platform,
      pathValue: getEnvValueCaseInsensitive(this.#parentEnv, "PATH") ?? "",
      ...(pathExt !== undefined ? { pathExt } : {}),
      fs: this.#fs,
      ...(this.#binaryName !== undefined ? { binaryName: this.#binaryName } : {}),
    });
    if (!resolution.found || resolution.executable === undefined) {
      return new PreflightFailedRun(
        parsedInput.runId,
        parsedInput.hallTask.taskId,
        parsedInput.agentIdentity.agentId,
        buildFailure(CODEX_CLI_NOT_FOUND, "Codex CLI could not be resolved."),
      );
    }

    // Codex normally requires a Git repository; this adapter never passes
    // --skip-git-repo-check for a normal task. Checked here, before ever
    // spawning Codex, so a non-repository working directory fails closed
    // with a stable Hall-specific diagnostic.
    if (!isInsideGitRepository(parsedInput.workingDirectory, this.#gitProbe)) {
      return new PreflightFailedRun(
        parsedInput.runId,
        parsedInput.hallTask.taskId,
        parsedInput.agentIdentity.agentId,
        buildFailure(
          CODEX_GIT_REPOSITORY_REQUIRED,
          "Codex requires the task's working directory to be inside a Git repository.",
        ),
      );
    }

    const prompt = buildCodexTaskPrompt({
      title: parsedInput.hallTask.title,
      description: parsedInput.hallTask.description,
      priority: parsedInput.hallTask.priority,
      projectId: parsedInput.hallTask.projectId,
    });

    const run = new CodexRun({
      executablePath: resolution.executable.path,
      args: buildCodexArgv(parsedInput.workingDirectory),
      prompt,
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

/**
 * Maps a detection result to a specific failure code. `availability`
 * alone can no longer distinguish every case since Phase 10.1: an
 * unverifiable isolation-flag profile, a non-ChatGPT auth method, and
 * (now, always, until file-edit execution is genuinely verified) a fully
 * "everything else checks out" result all share the single `"unsupported"`
 * availability value. `diagnosticMessage` is compared against the small,
 * fixed set of constants `detectCodex` itself produces — never arbitrary
 * or provider-controlled text — to recover the finer-grained reason.
 */
function failureCodeForUnavailableDetection(detection: AgentDetectionResult): string {
  switch (detection.availability) {
    case "unavailable":
      return CODEX_CLI_NOT_FOUND;
    case "logged_out":
      return CODEX_NOT_AUTHENTICATED;
    case "unsupported":
      if (
        detection.diagnosticMessage === UNSUPPORTED_ISOLATION_PROFILE_MESSAGE ||
        detection.diagnosticMessage === UNVERIFIED_EXECUTION_CAPABILITY_MESSAGE
      ) {
        return CODEX_ISOLATION_UNSUPPORTED;
      }
      return CODEX_CHATGPT_AUTH_UNVERIFIED;
    default:
      return CODEX_CHATGPT_AUTH_UNVERIFIED;
  }
}

function safeUnavailableMessage(detection: AgentDetectionResult): string {
  return detection.diagnosticMessage ?? "Codex is not currently available to execute this task.";
}
