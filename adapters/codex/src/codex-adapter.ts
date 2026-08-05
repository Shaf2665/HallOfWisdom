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
  TRUSTED_LOCAL_NOT_LOOPBACK_MESSAGE,
  TRUSTED_LOCAL_WORKSPACE_NOT_CONFIGURED_MESSAGE,
  TRUSTED_LOCAL_BILLING_ENV_BLOCKED_MESSAGE,
  STRICT_ISOLATION_BILLING_ENV_BLOCKED_MESSAGE,
  TRUSTED_LOCAL_FLAG_UNSUPPORTED_MESSAGE,
  STRICT_ISOLATION_DISABLED_MESSAGE,
  STRICT_ISOLATION_DURABILITY_REQUIRED_MESSAGE,
  STRICT_ISOLATION_WORKTREE_ROOT_REQUIRED_MESSAGE,
  STRICT_ISOLATION_VALIDATOR_REQUIRED_MESSAGE,
  STRICT_ISOLATION_SANDBOX_PROBE_FAILED_MESSAGE,
  STRICT_ISOLATION_SANDBOX_EQUIVALENCE_UNPROVEN_MESSAGE,
  type StrictIsolatedDetectionOptions,
  type TrustedLocalDetectionOptions,
} from "./detection.js";
import { resolveCodexExecutable, type FileSystemProbe } from "./executable-resolver.js";
import { realFileSystemProbe } from "./real-file-system-probe.js";
import { buildChildEnvironment } from "./environment.js";
import { buildCodexTaskPrompt } from "./prompt-builder.js";
import { buildCodexArgv, buildCodexTrustedLocalArgv } from "./permission-profile.js";
import { realCodexSandboxCompatibilityProbe } from "./sandbox-compatibility-probe.js";
import {
  isInsideGitRepository,
  realGitRepositoryProbe,
  type GitRepositoryProbe,
} from "./git-repository-check.js";
import {
  realWorkspaceWritabilityProbe,
  type WorkspaceWritabilityProbe,
} from "./workspace-writability-probe.js";
import { nodeProcessSpawner, type ProcessSpawner } from "./process-spawner.js";
import { CodexRun, type CodexPreSpawnGateResult } from "./codex-run.js";
import {
  buildFailure,
  CODEX_CLI_NOT_FOUND,
  CODEX_GIT_REPOSITORY_REQUIRED,
  CODEX_NOT_AUTHENTICATED,
  CODEX_CHATGPT_AUTH_UNVERIFIED,
  CODEX_ISOLATION_UNSUPPORTED,
  CODEX_WORKSPACE_NOT_WRITABLE,
  CODEX_WORKTREE_VALIDATION_FAILED,
} from "./failure-codes.js";
import { getEnvValueCaseInsensitive } from "./env-lookup.js";

/**
 * Phase 10.2 — an explicitly-enabled, Paperclip-compatible trusted-local
 * execution mode. Every field is constructor-time-only configuration:
 * never accepted from `AgentTaskInput`, `AgentExecutionOptions`, or
 * anything else that flows from a browser/REST request. `enabled` is the
 * single source of truth this adapter uses for both `detect()`'s
 * `available` branch and `startTask()`'s argv selection — see
 * `docs/architecture/0010-paperclip-compatible-codex-mode.md`.
 */
export type CodexTrustedLocalConfig = TrustedLocalDetectionOptions;
export type CodexStrictIsolatedConfig = StrictIsolatedDetectionOptions & {
  readonly validateWorktree?: CodexStrictWorktreeValidator | undefined;
};

export interface CodexStrictWorktreeValidationInput {
  readonly hallTaskId: string;
  readonly hallAgentRunId: string;
  readonly adapterId: string;
  readonly workingDirectory: string;
  readonly expectedWorktreeId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface CodexStrictWorktreeValidationResult {
  readonly ok: boolean;
  readonly worktreeId?: string | undefined;
}

export type CodexStrictWorktreeValidator = (
  input: CodexStrictWorktreeValidationInput,
) => Promise<CodexStrictWorktreeValidationResult>;

const TRUSTED_LOCAL_DISABLED: CodexTrustedLocalConfig = {
  enabled: false,
  loopbackBound: false,
  workspaceRoot: "",
};

const STRICT_ISOLATION_DISABLED: CodexStrictIsolatedConfig = {
  enabled: false,
  durableStorage: false,
  worktreeRoot: "",
  worktreeRootReady: false,
  validatorAvailable: false,
  sandboxProbe: realCodexSandboxCompatibilityProbe,
};

export interface CodexAdapterConfig {
  readonly platform?: NodeJS.Platform;
  readonly parentEnv?: Readonly<NodeJS.ProcessEnv>;
  readonly spawner?: ProcessSpawner;
  readonly fs?: FileSystemProbe;
  readonly gitProbe?: GitRepositoryProbe;
  readonly writabilityProbe?: WorkspaceWritabilityProbe;
  readonly binaryName?: string;
  readonly trustedLocal?: CodexTrustedLocalConfig;
  readonly strictIsolation?: CodexStrictIsolatedConfig;
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

class PreflightCancelledRun implements AgentRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<NormalizedAgentEvent>;
  readonly completion: Promise<NormalizedAgentEvent>;

  constructor(runId: string, taskId: string, agentId: string) {
    this.runId = runId;
    const factory = new EventFactory({ runId, taskId, agentId });
    const guard = new TerminalEventGuard();
    const event = guard.guardEvent(factory.runCancelled("system", undefined));
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

  readonly currentState: RunTerminalState = "cancelled";

  cancel(): void {
    // Already terminal the moment this object exists; nothing to cancel.
  }
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
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
  readonly #writabilityProbe: WorkspaceWritabilityProbe;
  readonly #binaryName: string | undefined;
  /**
   * Single source of truth for trusted-local mode: the exact same object
   * is threaded into `detectCodex` (the only thing that can make `detect()`
   * return `available`) and read directly in `startTask()` to choose
   * between `buildCodexArgv` and `buildCodexTrustedLocalArgv`. There is no
   * second flag anywhere in this class — see the deterministic test
   * "strict mode can never select the trusted-local argv" in
   * `codex-adapter.test.ts` for why this matters.
   */
  readonly #trustedLocal: CodexTrustedLocalConfig;
  readonly #strictIsolation: CodexStrictIsolatedConfig;
  readonly #strictIsolationConfigured: boolean;
  /**
   * Phase 10.3 — in-flight detection coalescing. When several callers
   * (e.g. overlapping `GET /api/v1/adapters` requests) invoke `detect()`
   * while one detection is already running, they share the same
   * in-progress promise instead of each starting an independent
   * `--version`/`login status`/`exec --help` spawn sequence. Cleared
   * unconditionally the moment that detection settles (success or
   * failure) in `#runDetection`'s `finally` — never kept as a
   * long-lived cache, and the very next call after that always starts a
   * genuinely fresh detection. This does not change `startTask()`'s own
   * "re-verify immediately before spawning" guarantee: it is only ever
   * about *concurrent* callers sharing work, never about serving a
   * stale result to a caller that arrives after the in-flight one
   * finished.
   */
  #inFlightDetection: Promise<AgentDetectionResult> | undefined;

  constructor(config: CodexAdapterConfig = {}) {
    this.#platform = config.platform ?? process.platform;
    this.#parentEnv = config.parentEnv ?? process.env;
    this.#spawner = config.spawner ?? nodeProcessSpawner;
    this.#fs = config.fs ?? realFileSystemProbe;
    this.#gitProbe = config.gitProbe ?? realGitRepositoryProbe;
    this.#writabilityProbe = config.writabilityProbe ?? realWorkspaceWritabilityProbe;
    this.#binaryName = config.binaryName;
    this.#trustedLocal = config.trustedLocal ?? TRUSTED_LOCAL_DISABLED;
    this.#strictIsolation = config.strictIsolation ?? STRICT_ISOLATION_DISABLED;
    this.#strictIsolationConfigured = config.strictIsolation !== undefined;
  }

  async detect(): Promise<AgentDetectionResult> {
    if (this.#inFlightDetection !== undefined) return this.#inFlightDetection;
    const promise = this.#runDetection();
    this.#inFlightDetection = promise;
    return promise;
  }

  async #runDetection(signal?: AbortSignal): Promise<AgentDetectionResult> {
    try {
      return await this.#detectFresh(signal);
    } finally {
      this.#inFlightDetection = undefined;
    }
  }

  async #detectFresh(signal?: AbortSignal): Promise<AgentDetectionResult> {
    const result = await detectCodex({
      platform: this.#platform,
      parentEnv: this.#parentEnv,
      fs: this.#fs,
      spawner: this.#spawner,
      trustedLocal: this.#trustedLocal,
      ...(this.#strictIsolationConfigured ? { strictIsolation: this.#strictIsolation } : {}),
      ...(this.#binaryName !== undefined ? { binaryName: this.#binaryName } : {}),
      ...(signal !== undefined ? { signal } : {}),
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

    if (isSignalAborted(options?.signal)) {
      return new PreflightCancelledRun(
        parsedInput.runId,
        parsedInput.hallTask.taskId,
        parsedInput.agentIdentity.agentId,
      );
    }

    // Billing-safety defense in depth: re-verify ChatGPT authentication at
    // the moment of execution, not only whenever the caller last called
    // detect(). Mirrors the Claude Code adapter's own discipline.
    const detection = await this.#detectFresh(options?.signal);
    if (isSignalAborted(options?.signal)) {
      return new PreflightCancelledRun(
        parsedInput.runId,
        parsedInput.hallTask.taskId,
        parsedInput.agentIdentity.agentId,
      );
    }
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

    if (isSignalAborted(options?.signal)) {
      return new PreflightCancelledRun(
        parsedInput.runId,
        parsedInput.hallTask.taskId,
        parsedInput.agentIdentity.agentId,
      );
    }

    // Codex normally requires a Git repository; this adapter never passes
    // --skip-git-repo-check for a normal task, trusted-local included.
    // Checked here, before ever spawning Codex, so a non-repository
    // working directory fails closed with a stable Hall-specific
    // diagnostic.
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

    if (isSignalAborted(options?.signal)) {
      return new PreflightCancelledRun(
        parsedInput.runId,
        parsedInput.hallTask.taskId,
        parsedInput.agentIdentity.agentId,
      );
    }

    let validatedWorktreeId: string | undefined;
    if (!this.#trustedLocal.enabled) {
      const worktreeValidation = await this.#validateStrictWorktree(parsedInput, options?.signal);
      if (worktreeValidation.cancelled) {
        return new PreflightCancelledRun(
          parsedInput.runId,
          parsedInput.hallTask.taskId,
          parsedInput.agentIdentity.agentId,
        );
      }
      if (!worktreeValidation.ok) {
        return new PreflightFailedRun(
          parsedInput.runId,
          parsedInput.hallTask.taskId,
          parsedInput.agentIdentity.agentId,
          buildFailure(
            CODEX_WORKTREE_VALIDATION_FAILED,
            "Codex strict isolated execution requires the exact validated Hall worktree.",
          ),
        );
      }
      validatedWorktreeId = worktreeValidation.worktreeId;
    }

    // Phase 10.2 — trusted-local mode's own writability preflight. Never
    // runs in strict mode (Codex's own sandbox already enforces
    // writability there). `parsedInput.workingDirectory` is the
    // orchestrator's already-canonicalized, workspace-root-contained,
    // symlink-escape-checked path (see TaskOrchestrator#resolveWorkingDirectory
    // / validateWorkspace in @hall-of-wisdom/hall-runner) — this adapter
    // never re-derives or re-resolves it, only probes whether it is
    // writable.
    if (
      this.#trustedLocal.enabled &&
      !this.#writabilityProbe.isWritable(parsedInput.workingDirectory)
    ) {
      return new PreflightFailedRun(
        parsedInput.runId,
        parsedInput.hallTask.taskId,
        parsedInput.agentIdentity.agentId,
        buildFailure(
          CODEX_WORKSPACE_NOT_WRITABLE,
          "Codex trusted-local execution requires the task's working directory to be writable.",
        ),
      );
    }

    if (isSignalAborted(options?.signal)) {
      return new PreflightCancelledRun(
        parsedInput.runId,
        parsedInput.hallTask.taskId,
        parsedInput.agentIdentity.agentId,
      );
    }

    const prompt = buildCodexTaskPrompt({
      title: parsedInput.hallTask.title,
      description: parsedInput.hallTask.description,
      priority: parsedInput.hallTask.priority,
      projectId: parsedInput.hallTask.projectId,
    });

    // The same #trustedLocal.enabled field that gated detect()'s
    // "available" result above is the only thing that selects the
    // Paperclip-compatible bypass argv. Strict mode (the default) always
    // reaches buildCodexArgv, byte-for-byte the Phase 10.1 profile.
    const args = this.#trustedLocal.enabled
      ? buildCodexTrustedLocalArgv(parsedInput.workingDirectory)
      : buildCodexArgv(parsedInput.workingDirectory);

    const run = new CodexRun({
      executablePath: resolution.executable.path,
      args,
      prompt,
      workingDirectory: parsedInput.workingDirectory,
      env: buildChildEnvironment(this.#parentEnv),
      spawner: this.#spawner,
      platform: this.#platform,
      runId: parsedInput.runId,
      taskId: parsedInput.hallTask.taskId,
      agentId: parsedInput.agentIdentity.agentId,
      ...(!this.#trustedLocal.enabled
        ? {
            preSpawnGate: (signal) =>
              this.#validateStrictWorktreeForSpawn(parsedInput, signal, validatedWorktreeId),
          }
        : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
    return Promise.resolve(run);
  }

  async #validateStrictWorktree(
    input: AgentTaskInput,
    signal: AbortSignal | undefined,
    expectedWorktreeId?: string,
  ): Promise<CodexStrictWorktreeValidationResult & { readonly cancelled?: boolean }> {
    if (isSignalAborted(signal)) return { ok: false, cancelled: true };
    if (
      !this.#strictIsolation.enabled ||
      !this.#strictIsolation.durableStorage ||
      this.#strictIsolation.worktreeRoot.trim().length === 0 ||
      this.#strictIsolation.worktreeRootReady !== true ||
      this.#strictIsolation.validatorAvailable !== true ||
      this.#strictIsolation.validateWorktree === undefined
    ) {
      return { ok: false };
    }
    try {
      const result = await this.#strictIsolation.validateWorktree({
        hallTaskId: input.hallTask.taskId,
        hallAgentRunId: input.runId,
        adapterId: input.agentIdentity.adapterId,
        workingDirectory: input.workingDirectory,
        ...(expectedWorktreeId !== undefined ? { expectedWorktreeId } : {}),
        ...(signal === undefined ? {} : { signal }),
      });
      if (isSignalAborted(signal)) return { ok: false, cancelled: true };
      if (!result.ok) return result;
      if (result.worktreeId === undefined) return { ok: false };
      if (expectedWorktreeId !== undefined && result.worktreeId !== expectedWorktreeId) {
        return { ok: false };
      }
      return result;
    } catch {
      if (isSignalAborted(signal)) return { ok: false, cancelled: true };
      return { ok: false };
    }
  }

  async #validateStrictWorktreeForSpawn(
    input: AgentTaskInput,
    signal: AbortSignal,
    expectedWorktreeId: string | undefined,
  ): Promise<CodexPreSpawnGateResult> {
    const validation = await this.#validateStrictWorktree(input, signal, expectedWorktreeId);
    if (validation.cancelled) return { ok: false, cancelled: true };
    if (validation.ok) return { ok: true };
    return {
      ok: false,
      failure: buildFailure(
        CODEX_WORKTREE_VALIDATION_FAILED,
        "Codex strict isolated execution requires the exact validated Hall worktree.",
      ),
    };
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
        detection.diagnosticMessage === UNVERIFIED_EXECUTION_CAPABILITY_MESSAGE ||
        // Phase 10.2 — every trusted-local precondition failure is a
        // capability/environment mismatch, not an auth problem; bucketed
        // with the existing isolation-unsupported code rather than
        // defaulting to the ChatGPT-auth code below.
        detection.diagnosticMessage === TRUSTED_LOCAL_NOT_LOOPBACK_MESSAGE ||
        detection.diagnosticMessage === TRUSTED_LOCAL_WORKSPACE_NOT_CONFIGURED_MESSAGE ||
        detection.diagnosticMessage === TRUSTED_LOCAL_BILLING_ENV_BLOCKED_MESSAGE ||
        detection.diagnosticMessage === TRUSTED_LOCAL_FLAG_UNSUPPORTED_MESSAGE ||
        detection.diagnosticMessage === STRICT_ISOLATION_DISABLED_MESSAGE ||
        detection.diagnosticMessage === STRICT_ISOLATION_DURABILITY_REQUIRED_MESSAGE ||
        detection.diagnosticMessage === STRICT_ISOLATION_WORKTREE_ROOT_REQUIRED_MESSAGE ||
        detection.diagnosticMessage === STRICT_ISOLATION_VALIDATOR_REQUIRED_MESSAGE ||
        detection.diagnosticMessage === STRICT_ISOLATION_BILLING_ENV_BLOCKED_MESSAGE ||
        detection.diagnosticMessage === STRICT_ISOLATION_SANDBOX_PROBE_FAILED_MESSAGE ||
        detection.diagnosticMessage === STRICT_ISOLATION_SANDBOX_EQUIVALENCE_UNPROVEN_MESSAGE
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
