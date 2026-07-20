import { EventFactory, TerminalEventGuard } from "@hall-of-wisdom/agent-adapter-sdk";
import { EventAfterTerminationError } from "@hall-of-wisdom/agent-adapter-sdk";
import type { AgentRunHandle, RunTerminalState } from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { AsyncQueue } from "./async-queue.js";
import { StreamParser, type StreamLineOutcome } from "./stream-parser.js";
import { EventMapper } from "./event-mapper.js";
import type { ProcessSpawner, SpawnedProcessHandle } from "./process-spawner.js";
import {
  forceTerminateProcessTree,
  requestGracefulTermination,
  type PosixGroupKiller,
} from "./process-tree.js";
import {
  buildFailure,
  CLAUDE_PROCESS_EXITED,
  CLAUDE_PROCESS_START_FAILED,
  CLAUDE_RESULT_MISSING,
  CLAUDE_STREAM_INVALID,
  CLAUDE_STREAM_TRUNCATED,
  CLAUDE_TURN_LIMIT_REACHED,
} from "./failure-codes.js";

const DEFAULT_GRACE_PERIOD_MS = 5000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RUN_DURATION_MS = 600_000;
const MAX_TOLERATED_MALFORMED_LINES = 5;
/**
 * Once the process has exited but stdout has not yet naturally emitted
 * "end" (see the comment on the "end" listener in `#start()`), this bounds
 * how long finalization waits for that drain signal before proceeding
 * anyway. Without this bound, a descendant process that inherited the
 * stdout pipe and kept it open after the main `claude` process exited
 * could delay finalization all the way out to `maxRunDurationMs` (ten
 * minutes by default) even though the run is already effectively over.
 */
const DEFAULT_POST_EXIT_STDOUT_DRAIN_GRACE_MS = 2000;

export interface ClaudeCodeRunOptions {
  readonly executablePath: string;
  readonly args: readonly string[];
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
  readonly postExitStdoutDrainGraceMs?: number;
  /** Test-only injection point — see `process-tree.ts`'s `PosixGroupKiller` doc comment for why this must never default to a real kill in a test. */
  readonly posixGroupKiller?: PosixGroupKiller;
}

/** Defeats TypeScript's incorrect narrowing of a `readonly aborted` property, mirroring `MockAgentRun`. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Executes one Claude Code task as a real child process and presents it
 * through the same `AgentRunHandle` contract `MockAgentRun` implements —
 * a lazy `AsyncIterable<NormalizedAgentEvent>` that drives the actual
 * process spawn on first iteration, an `EventFactory` + `TerminalEventGuard`
 * pair owning this run's envelope/terminal-state discipline, and an
 * idempotent `cancel()`. The real difference from `MockAgentRun` is that
 * events arrive from a push-based child process (stdout data/exit/error
 * callbacks) rather than a synchronous generator loop — `AsyncQueue`
 * bridges the two. See `docs/architecture/0008-claude-code-adapter.md`,
 * "Process-tree cancellation", for the two-phase (graceful, then forced)
 * termination sequence this class drives through `process-tree.ts`.
 */
export class ClaudeCodeRun implements AgentRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<NormalizedAgentEvent>;

  readonly #options: ClaudeCodeRunOptions;
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
  #startupTimer: ReturnType<typeof setTimeout> | undefined;
  #gracePeriodTimer: ReturnType<typeof setTimeout> | undefined;
  #maxDurationTimer: ReturnType<typeof setTimeout> | undefined;
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

  constructor(options: ClaudeCodeRunOptions) {
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
          CLAUDE_TURN_LIMIT_REACHED,
          "Claude Code did not complete within the allotted run time.",
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
      this.#finishFailed(
        buildFailure(CLAUDE_PROCESS_START_FAILED, "Claude Code could not be started."),
      );
      return;
    }
    this.#processHandle = handle;
    // "Child successfully starts" -> run.started: a process-lifecycle
    // event fired as soon as spawn succeeds, independent of whatever the
    // stream later reports — matching the SDK's requirement that this be
    // the very first event of the run, before any content.
    this.#queue.push(this.#guard.guardEvent(this.#factory.runStarted()));

    this.#startupTimer = setTimeout(() => {
      this.#failAndTerminateProcess(
        buildFailure(
          CLAUDE_PROCESS_START_FAILED,
          "Claude Code did not produce any output before the startup timeout.",
        ),
      );
    }, this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);

    handle.onError(() => {
      this.#clearStartupTimer();
      this.#finishFailed(
        buildFailure(
          CLAUDE_PROCESS_START_FAILED,
          "Claude Code process could not be started or crashed.",
        ),
      );
    });

    this.#stdoutHandler = (chunk: Buffer) => {
      this.#clearStartupTimer();
      this.#handleStdoutChunk(chunk.toString("utf8"));
    };
    handle.stdout.on("data", this.#stdoutHandler);

    // Node does not guarantee stdout's "data"/"end" events are fully
    // drained before the child process emits "exit" — "exit" fires on
    // process termination, while stdout may still have buffered bytes
    // in flight. Finalizing on "exit" alone risks reading the process as
    // having produced no terminal result when the final stream-json line
    // (e.g. the "result" message) simply hadn't been delivered to this
    // handler yet. So the "no terminal event was ever seen" conclusion is
    // only drawn once BOTH the process has exited AND stdout has ended.
    this.#stdoutEndHandler = () => {
      this.#stdoutEnded = true;
      this.#clearPostExitStdoutDrainTimer();
      this.#tryFinalizeAfterExit();
    };
    handle.stdout.on("end", this.#stdoutEndHandler);

    // Captured only to distinguish an unexpected nonzero exit from a
    // clean one in a future diagnostic — never forwarded raw into any
    // Hall event. Bounded the same way stdout is, via the underlying
    // stream simply not being read beyond what Node buffers; no separate
    // accumulation is kept here in Phase 9.
    this.#stderrHandler = () => undefined;
    handle.stderr.on("data", this.#stderrHandler);

    handle.onExit((exitCode, signal) => {
      this.#clearStartupTimer();
      this.#exitInfo = { code: exitCode, signal };
      // If stdout has already ended, this finalizes immediately below and
      // the timer started here would just be cleared again as a no-op in
      // #cleanup(). If stdout has not ended yet, this bounds how long
      // finalization waits for it — see DEFAULT_POST_EXIT_STDOUT_DRAIN_GRACE_MS.
      if (!this.#stdoutEnded) {
        this.#postExitStdoutDrainTimer = setTimeout(() => {
          this.#stdoutEnded = true;
          this.#tryFinalizeAfterExit();
        }, this.#options.postExitStdoutDrainGraceMs ?? DEFAULT_POST_EXIT_STDOUT_DRAIN_GRACE_MS);
      }
      this.#tryFinalizeAfterExit();
    });
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

  #handleStdoutChunk(text: string): void {
    if (this.#guard.isTerminated) return;
    // Each outcome is handled even if an earlier one in the same chunk
    // already reached a terminal state: `#handleParserOutcome`'s
    // "messages" branch re-checks `isTerminated` per message, and every
    // other branch routes through `#finishFailed`, whose `guardEvent`
    // call safely no-ops (catching `EventAfterTerminationError`) once
    // already terminal — so no separate guard is needed in this loop.
    for (const outcome of this.#parser.push(text)) {
      this.#handleParserOutcome(outcome);
    }
  }

  #handleParserOutcome(outcome: StreamLineOutcome): void {
    switch (outcome.kind) {
      case "messages":
        for (const message of outcome.messages) {
          if (this.#guard.isTerminated) return;
          for (const event of this.#mapper.mapMessage(message)) {
            this.#queue.push(event);
            if (
              event.type === "run.completed" ||
              event.type === "run.failed" ||
              event.type === "run.cancelled"
            ) {
              this.#resolveCompletion(event);
              this.#queue.close();
            }
          }
        }
        return;
      case "malformed-json":
      case "invalid-line":
        this.#malformedLineCount += 1;
        if (this.#malformedLineCount > MAX_TOLERATED_MALFORMED_LINES) {
          this.#failAndTerminateProcess(
            buildFailure(
              CLAUDE_STREAM_INVALID,
              "Claude Code produced too many malformed stream lines.",
            ),
          );
        }
        return;
      case "oversized-line":
        this.#failAndTerminateProcess(
          buildFailure(CLAUDE_STREAM_INVALID, "Claude Code produced an oversized stream line."),
        );
        return;
      case "message-limit-reached":
        this.#failAndTerminateProcess(
          buildFailure(
            CLAUDE_TURN_LIMIT_REACHED,
            "Claude Code exceeded the maximum number of stream messages permitted for one task.",
          ),
        );
        return;
      case "truncated-final-line":
        this.#failAndTerminateProcess(
          buildFailure(CLAUDE_STREAM_TRUNCATED, "Claude Code's output stream ended mid-message."),
        );
        return;
    }
  }

  // Only draws a "the process ended with no terminal event" conclusion once
  // both the exit callback has fired AND stdout has fully drained — see the
  // comment on the "end" listener in `#start()` for why neither signal
  // alone is sufficient.
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
        buildFailure(CLAUDE_RESULT_MISSING, "Claude Code exited without reporting a final result."),
      );
    } else {
      this.#finishFailed(
        buildFailure(
          CLAUDE_PROCESS_EXITED,
          `Claude Code exited unexpectedly with code ${String(exitCode ?? "unknown")}.`,
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
    }
    this.#externalSignalCleanup?.();
    this.#externalSignalCleanup = undefined;
  }
}
