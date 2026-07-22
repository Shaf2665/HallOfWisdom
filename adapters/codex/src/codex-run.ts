import { EventFactory, TerminalEventGuard } from "@hall-of-wisdom/agent-adapter-sdk";
import { EventAfterTerminationError } from "@hall-of-wisdom/agent-adapter-sdk";
import type { AgentRunHandle, RunTerminalState } from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { AsyncQueue } from "./async-queue.js";
import { StreamParser, type StreamLineOutcome } from "./codex-stream-parser.js";
import { EventMapper } from "./event-mapper.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";
import {
  forceTerminateProcessTree,
  requestGracefulTermination,
  type PosixGroupKiller,
} from "./process-tree.js";
import {
  buildFailure,
  CODEX_OUTPUT_INACTIVITY_TIMEOUT,
  CODEX_PROCESS_EXITED,
  CODEX_PROCESS_START_FAILED,
  CODEX_RESULT_MISSING,
  CODEX_STREAM_INVALID,
  CODEX_STREAM_TRUNCATED,
  CODEX_USAGE_LIMIT_REACHED,
} from "./failure-codes.js";

const DEFAULT_GRACE_PERIOD_MS = 5000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RUN_DURATION_MS = 600_000;
/**
 * Phase 10.2 — bounded no-output inactivity timeout, reviewed alongside
 * Paperclip's own inactivity-monitor concept (`execute.ts`,
 * `createCodexOutputInactivityMonitor`) but independently reimplemented
 * against this class's own timer/termination plumbing — see
 * `docs/architecture/0010-paperclip-compatible-codex-mode.md`. Distinct
 * from `#startupTimer` (which only ever guards the silence *before the
 * first byte* and is cleared permanently after it) and from
 * `#maxDurationTimer` (an absolute cap on the whole run regardless of
 * activity): this timer re-arms on every stdout *or* stderr chunk and
 * fires if none arrives for this long at any point during the run,
 * including well after the first byte. Longer than the startup timeout
 * since legitimate mid-run silence (e.g. a long-running shell command)
 * is more normal than a completely silent startup.
 */
const DEFAULT_INACTIVITY_TIMEOUT_MS = 120_000;
const MAX_TOLERATED_MALFORMED_LINES = 5;
/**
 * Once the process has exited but stdout has not yet naturally emitted
 * "end", this bounds how long finalization waits for that drain signal
 * before proceeding anyway — mirrors the same race documented in the
 * Claude Code adapter's `claude-code-run.ts`.
 */
const DEFAULT_POST_EXIT_STDOUT_DRAIN_GRACE_MS = 2000;

export interface CodexRunOptions {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly prompt: string;
  readonly workingDirectory: string;
  readonly env: Readonly<Record<string, string>>;
  readonly spawner: ProcessSpawner;
  readonly platform: NodeJS.Platform;
  readonly runId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly signal?: AbortSignal | undefined;
  readonly gracefulTerminationTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly maxRunDurationMs?: number;
  readonly inactivityTimeoutMs?: number;
  readonly postExitStdoutDrainGraceMs?: number;
  /** Test-only injection point — see `process-tree.ts`'s `PosixGroupKiller` doc comment. */
  readonly posixGroupKiller?: PosixGroupKiller;
}

/** Defeats TypeScript's incorrect narrowing of a `readonly aborted` property. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Executes one Codex task as a real child process and presents it through
 * the same `AgentRunHandle` contract every other Hall adapter implements —
 * a lazy `AsyncIterable<NormalizedAgentEvent>` that drives the actual
 * process spawn on first iteration, an `EventFactory` +
 * `TerminalEventGuard` pair owning this run's envelope/terminal-state
 * discipline, and an idempotent `cancel()`. `AsyncQueue` bridges the
 * push-based child process callbacks to the pull-based async iterator.
 *
 * Unlike the Claude Code adapter, the task prompt is never part of `args`
 * — it is written to the child's stdin immediately after `run.started` is
 * emitted, then stdin is closed (the `"-"` sentinel in `args`, from
 * `permission-profile.ts`, is Codex's own convention for "read the prompt
 * from stdin"). See `docs/architecture/0009-codex-adapter.md`,
 * "Process launching".
 */
export class CodexRun implements AgentRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<NormalizedAgentEvent>;

  readonly #options: CodexRunOptions;
  readonly #factory: EventFactory;
  readonly #guard: TerminalEventGuard;
  readonly #mapper: EventMapper;
  readonly #parser = new StreamParser();
  readonly #queue = new AsyncQueue<NormalizedAgentEvent>();
  readonly #controller = new AbortController();

  #processHandle: SpawnedProcessHandle | undefined;
  #stdoutHandler: ((chunk: Buffer) => void) | undefined;
  #stdoutEndHandler: (() => void) | undefined;
  #stderrHandler: ((chunk: Buffer) => void) | undefined;
  #stdinErrorHandler: ((error: Error) => void) | undefined;
  #startupTimer: ReturnType<typeof setTimeout> | undefined;
  #gracePeriodTimer: ReturnType<typeof setTimeout> | undefined;
  #maxDurationTimer: ReturnType<typeof setTimeout> | undefined;
  #inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  #postExitStdoutDrainTimer: ReturnType<typeof setTimeout> | undefined;
  #externalSignalCleanup: (() => void) | undefined;

  #cancellationRecorded = false;
  #cancellationRequested = false;
  #cancelledBy: "orchestrator" | "system" = "system";
  #cancelReason: string | undefined;
  #malformedLineCount = 0;
  #started = false;
  #exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  #stdoutEnded = false;

  readonly #completionPromise: Promise<NormalizedAgentEvent>;
  #resolveCompletion!: (event: NormalizedAgentEvent) => void;

  constructor(options: CodexRunOptions) {
    this.#options = options;
    this.runId = options.runId;
    this.#factory = new EventFactory({
      runId: options.runId,
      taskId: options.taskId,
      agentId: options.agentId,
    });
    this.#guard = new TerminalEventGuard();
    this.#mapper = new EventMapper(this.#factory, this.#guard, {
      workingDirectory: options.workingDirectory,
    });
    this.#completionPromise = new Promise((resolve) => {
      this.#resolveCompletion = resolve;
    });
    this.events = { [Symbol.asyncIterator]: () => this.#run() };

    const externalSignal = options.signal;
    if (externalSignal !== undefined) {
      if (isAborted(externalSignal)) {
        this.#recordCancellation("system", undefined);
      } else {
        const onAbort = () => {
          this.#recordCancellation("system", undefined);
        };
        externalSignal.addEventListener("abort", onAbort, { once: true });
        this.#externalSignalCleanup = () => {
          externalSignal.removeEventListener("abort", onAbort);
        };
      }
    }
  }

  get currentState(): RunTerminalState {
    const terminal = this.#guard.terminalEvent;
    if (terminal === undefined) return "running";
    if (terminal.type === "run.completed") return "completed";
    if (terminal.type === "run.failed") return "failed";
    return "cancelled";
  }

  get completion(): Promise<NormalizedAgentEvent> {
    return this.#completionPromise;
  }

  cancel(reason?: string): void {
    this.#recordCancellation("orchestrator", reason);
  }

  #recordCancellation(cancelledBy: "orchestrator" | "system", reason: string | undefined): void {
    if (this.#cancellationRecorded) return;
    this.#cancellationRecorded = true;
    this.#cancelledBy = cancelledBy;
    this.#cancelReason = reason;
    this.#controller.abort(reason);
  }

  async *#run(): AsyncGenerator<NormalizedAgentEvent> {
    if (!this.#started) {
      this.#started = true;
      this.#start();
    }
    for await (const event of this.#queue) {
      yield event;
    }
  }

  #start(): void {
    if (isAborted(this.#controller.signal)) {
      this.#finishCancelled();
      return;
    }

    this.#controller.signal.addEventListener(
      "abort",
      () => {
        this.#beginCancellationSequence();
      },
      { once: true },
    );

    this.#maxDurationTimer = setTimeout(() => {
      this.#failAndTerminateProcess(
        buildFailure(
          CODEX_USAGE_LIMIT_REACHED,
          "Codex did not complete within the allotted run time.",
        ),
      );
    }, this.#options.maxRunDurationMs ?? DEFAULT_MAX_RUN_DURATION_MS);

    let handle: SpawnedProcessHandle;
    try {
      handle = this.#options.spawner.spawn(this.#options.executablePath, this.#options.args, {
        cwd: this.#options.workingDirectory,
        env: this.#options.env,
      });
    } catch {
      this.#finishFailed(buildFailure(CODEX_PROCESS_START_FAILED, "Codex could not be started."));
      return;
    }
    this.#processHandle = handle;
    // "Child successfully starts" -> run.started: a process-lifecycle
    // event fired as soon as spawn succeeds, independent of whatever the
    // stream later reports.
    this.#queue.push(this.#guard.guardEvent(this.#factory.runStarted()));

    this.#armInactivityTimer();

    this.#startupTimer = setTimeout(() => {
      this.#failAndTerminateProcess(
        buildFailure(
          CODEX_PROCESS_START_FAILED,
          "Codex did not produce any output before the startup timeout.",
        ),
      );
    }, this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);

    handle.onError(() => {
      this.#clearStartupTimer();
      this.#finishFailed(
        buildFailure(CODEX_PROCESS_START_FAILED, "Codex process could not be started or crashed."),
      );
    });

    this.#writePromptToStdin(handle);

    this.#stdoutHandler = (chunk: Buffer) => {
      this.#clearStartupTimer();
      this.#armInactivityTimer();
      this.#handleStdoutChunk(chunk.toString("utf8"));
    };
    handle.stdout.on("data", this.#stdoutHandler);

    // Node does not guarantee stdout's "data"/"end" events are fully
    // drained before the child process emits "exit" — see the identical
    // comment in the Claude Code adapter's `claude-code-run.ts` for the
    // full reasoning behind waiting for both signals.
    this.#stdoutEndHandler = () => {
      this.#stdoutEnded = true;
      this.#clearPostExitStdoutDrainTimer();
      this.#tryFinalizeAfterExit();
    };
    handle.stdout.on("end", this.#stdoutEndHandler);

    // Phase 10.1 correction: stderr is never parsed as JSONL and never
    // produces a Hall event, a terminal outcome, or any provider-event
    // ordering signal — stdout is the sole authoritative native-event
    // stream for `codex exec --json` (confirmed by the installed CLI's
    // own documentation and behavior). Phase 10 originally also parsed
    // stderr as a defensive hedge, reasoning from the unrelated
    // discovery that `codex login status` puts its message on stderr —
    // but `login status` and `exec --json` are different commands with
    // no guarantee of sharing a stream convention, and treating stderr
    // as a second authoritative event source created exactly the classes
    // of risk (false terminal events, injected tool/file events from
    // diagnostic noise) a security review must not accept speculatively.
    // stderr bytes are received and immediately discarded — never
    // parsed, stored, classified, or forwarded anywhere, including into
    // a `StructuredFailure` or any Hall event. See
    // `docs/architecture/0009-codex-adapter.md`, "Event-channel
    // isolation". Phase 10.2: the one exception is the inactivity timer
    // reset below — it only observes that a chunk arrived (a liveness
    // fact), never its content, so this remains consistent with that
    // isolation guarantee.
    this.#stderrHandler = () => {
      this.#armInactivityTimer();
    };
    handle.stderr.on("data", this.#stderrHandler);

    handle.onExit((exitCode, signal) => {
      this.#clearStartupTimer();
      this.#exitInfo = { code: exitCode, signal };
      if (!this.#stdoutEnded) {
        this.#postExitStdoutDrainTimer = setTimeout(() => {
          this.#stdoutEnded = true;
          this.#tryFinalizeAfterExit();
        }, this.#options.postExitStdoutDrainGraceMs ?? DEFAULT_POST_EXIT_STDOUT_DRAIN_GRACE_MS);
      }
      this.#tryFinalizeAfterExit();
    });
  }

  /**
   * Delivers the task prompt over stdin, then closes it. An early stdin
   * failure (the pipe closed before or during the write, e.g. because the
   * child process exited immediately) is handled the same way a process
   * start failure is — never left as an unhandled stream "error" event,
   * which would otherwise crash the whole adapter process.
   */
  #writePromptToStdin(handle: SpawnedProcessHandle): void {
    let stdinFailed = false;
    this.#stdinErrorHandler = () => {
      if (stdinFailed || this.#guard.isTerminated) return;
      stdinFailed = true;
      this.#failAndTerminateProcess(
        buildFailure(
          CODEX_PROCESS_START_FAILED,
          "Codex process could not receive its task prompt.",
        ),
      );
    };
    handle.stdin.on("error", this.#stdinErrorHandler);

    try {
      handle.stdin.write(this.#options.prompt, "utf8", () => {
        handle.stdin.end();
      });
    } catch {
      // stdinFailed cannot yet be true here: nothing between its
      // declaration and this synchronous catch can have set it (the
      // async "error" listener above fires on a later microtask/event
      // loop turn, not during this synchronous write() call).
      if (!this.#guard.isTerminated) {
        stdinFailed = true;
        this.#failAndTerminateProcess(
          buildFailure(
            CODEX_PROCESS_START_FAILED,
            "Codex process could not receive its task prompt.",
          ),
        );
      }
    }
  }

  #clearPostExitStdoutDrainTimer(): void {
    if (this.#postExitStdoutDrainTimer !== undefined) {
      clearTimeout(this.#postExitStdoutDrainTimer);
      this.#postExitStdoutDrainTimer = undefined;
    }
  }

  #clearStartupTimer(): void {
    if (this.#startupTimer !== undefined) {
      clearTimeout(this.#startupTimer);
      this.#startupTimer = undefined;
    }
  }

  /** Re-arms the bounded inactivity timer; a no-op after the run has already terminated. */
  #armInactivityTimer(): void {
    if (this.#guard.isTerminated) return;
    if (this.#inactivityTimer !== undefined) {
      clearTimeout(this.#inactivityTimer);
    }
    this.#inactivityTimer = setTimeout(() => {
      if (this.#guard.isTerminated) return;
      this.#failAndTerminateProcess(
        buildFailure(
          CODEX_OUTPUT_INACTIVITY_TIMEOUT,
          "Codex produced no output for longer than the allotted inactivity timeout.",
        ),
      );
    }, this.#options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS);
  }

  #clearInactivityTimer(): void {
    if (this.#inactivityTimer !== undefined) {
      clearTimeout(this.#inactivityTimer);
      this.#inactivityTimer = undefined;
    }
  }

  #handleStdoutChunk(text: string): void {
    if (this.#guard.isTerminated) return;
    for (const outcome of this.#parser.push(text)) {
      this.#handleParserOutcome(outcome);
    }
  }

  #dispatchMappedEvents(events: readonly NormalizedAgentEvent[]): void {
    for (const event of events) {
      this.#queue.push(event);
      if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled"
      ) {
        this.#clearInactivityTimer();
        this.#resolveCompletion(event);
        this.#queue.close();
      }
    }
  }

  #handleParserOutcome(outcome: StreamLineOutcome): void {
    switch (outcome.kind) {
      case "messages":
        for (const message of outcome.messages) {
          if (this.#guard.isTerminated) return;
          this.#dispatchMappedEvents(this.#mapper.mapMessage(message));
        }
        return;
      case "malformed-json":
      case "invalid-line":
        this.#malformedLineCount += 1;
        if (this.#malformedLineCount > MAX_TOLERATED_MALFORMED_LINES) {
          this.#failAndTerminateProcess(
            buildFailure(CODEX_STREAM_INVALID, "Codex produced too many malformed stream lines."),
          );
        }
        return;
      case "oversized-line":
        this.#failAndTerminateProcess(
          buildFailure(CODEX_STREAM_INVALID, "Codex produced an oversized stream line."),
        );
        return;
      case "message-limit-reached":
        this.#failAndTerminateProcess(
          buildFailure(
            CODEX_STREAM_INVALID,
            "Codex exceeded the maximum number of stream messages permitted for one task.",
          ),
        );
        return;
      case "truncated-final-line":
        this.#failAndTerminateProcess(
          buildFailure(CODEX_STREAM_TRUNCATED, "Codex's output stream ended mid-message."),
        );
        return;
    }
  }

  #tryFinalizeAfterExit(): void {
    if (this.#exitInfo === undefined || !this.#stdoutEnded) return;
    const { code: exitCode } = this.#exitInfo;

    if (!this.#guard.isTerminated) {
      for (const outcome of this.#parser.flush()) {
        this.#handleParserOutcome(outcome);
      }
    }

    if (this.#guard.isTerminated) {
      this.#cleanup();
      return;
    }

    if (this.#cancellationRequested) {
      this.#finishCancelled();
    } else if (exitCode === 0) {
      this.#finishFailed(
        buildFailure(CODEX_RESULT_MISSING, "Codex exited without reporting a final result."),
      );
    } else {
      this.#finishFailed(
        buildFailure(
          CODEX_PROCESS_EXITED,
          `Codex exited unexpectedly with code ${String(exitCode ?? "unknown")}.`,
        ),
      );
    }
    this.#cleanup();
  }

  #beginCancellationSequence(): void {
    if (this.#guard.isTerminated) return;
    this.#cancellationRequested = true;
    this.#terminateProcess();
  }

  #failAndTerminateProcess(failure: ReturnType<typeof buildFailure>): void {
    this.#finishFailed(failure);
    this.#terminateProcess();
  }

  #terminateProcess(): void {
    const handle = this.#processHandle;
    if (handle === undefined) return;
    handle.kill();
    if (handle.pid !== undefined) {
      const pid = handle.pid;
      const { platform, spawner, env, posixGroupKiller } = this.#options;
      requestGracefulTermination({
        platform,
        pid,
        spawner,
        env,
        ...(posixGroupKiller !== undefined ? { posixGroupKiller } : {}),
      });
      this.#gracePeriodTimer = setTimeout(() => {
        forceTerminateProcessTree({
          platform,
          pid,
          spawner,
          env,
          ...(posixGroupKiller !== undefined ? { posixGroupKiller } : {}),
        });
      }, this.#options.gracefulTerminationTimeoutMs ?? DEFAULT_GRACE_PERIOD_MS);
    }
  }

  #finishCancelled(): void {
    try {
      const event = this.#guard.guardEvent(
        this.#factory.runCancelled(this.#cancelledBy, this.#cancelReason),
      );
      this.#queue.push(event);
      this.#resolveCompletion(event);
    } catch (error) {
      if (!(error instanceof EventAfterTerminationError)) throw error;
    }
    this.#queue.close();
    this.#cleanup();
  }

  #finishFailed(failure: ReturnType<typeof buildFailure>): void {
    try {
      const event = this.#guard.guardEvent(this.#factory.runFailed(failure));
      this.#queue.push(event);
      this.#resolveCompletion(event);
    } catch (error) {
      if (!(error instanceof EventAfterTerminationError)) throw error;
    }
    this.#queue.close();
  }

  #cleanup(): void {
    this.#clearStartupTimer();
    this.#clearInactivityTimer();
    if (this.#gracePeriodTimer !== undefined) {
      clearTimeout(this.#gracePeriodTimer);
      this.#gracePeriodTimer = undefined;
    }
    if (this.#maxDurationTimer !== undefined) {
      clearTimeout(this.#maxDurationTimer);
      this.#maxDurationTimer = undefined;
    }
    this.#clearPostExitStdoutDrainTimer();
    const handle = this.#processHandle;
    if (handle !== undefined) {
      if (this.#stdoutHandler !== undefined)
        handle.stdout.removeListener("data", this.#stdoutHandler);
      if (this.#stdoutEndHandler !== undefined)
        handle.stdout.removeListener("end", this.#stdoutEndHandler);
      if (this.#stderrHandler !== undefined)
        handle.stderr.removeListener("data", this.#stderrHandler);
      if (this.#stdinErrorHandler !== undefined)
        handle.stdin.removeListener("error", this.#stdinErrorHandler);
    }
    this.#externalSignalCleanup?.();
    this.#externalSignalCleanup = undefined;
  }
}
