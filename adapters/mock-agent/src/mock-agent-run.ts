import {
  EventFactory,
  EventAfterTerminationError,
  TerminalEventGuard,
  type AgentRunHandle,
  type AgentTaskInput,
  type RunTerminalState,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { CancelledBy, NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { delay } from "./delay.js";
import type { MockAgentConfig } from "./config.js";

/**
 * Reads `signal.aborted` through a function call rather than as a direct
 * property access. `AbortSignal.aborted` is declared `readonly`, which
 * leads TypeScript's control-flow narrowing to (incorrectly, for this
 * mutable external object) treat it as permanently `false` for the rest
 * of a function after one `if (signal.aborted)` check — even though
 * `abort()` genuinely flips it later. Wrapping the read in a function call
 * sidesteps that false narrowing instead of suppressing the lint rule.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Concrete `AgentRunHandle` for the Mock Agent. Owns exactly one
 * `TerminalEventGuard` and one `EventFactory` per run, and uses the
 * shared guard/factory from `@hall-of-wisdom/agent-adapter-sdk` rather than
 * reimplementing sequencing or terminal-event enforcement.
 *
 * Cancellation model: a single internal `AbortController` is the run's one
 * source of truth for "has cancellation been requested". Both cancellation
 * paths — the explicit `cancel()` method and an externally-supplied
 * `AbortSignal` — funnel into `#recordCancellation`, which records who
 * requested it (first caller wins) and aborts the internal controller
 * exactly once. `cancelledBy` is `"orchestrator"` for an explicit
 * `cancel()` call (the caller holding the handle — normally Hall Runner,
 * acting on the orchestrator's behalf) and `"system"` for an externally
 * supplied `AbortSignal` firing (Hall-provided infrastructure such as a
 * timeout or process shutdown).
 *
 * Consuming `events` is what drives execution forward: this is a lazy
 * async generator, so nothing runs until a caller starts iterating.
 * `completion` resolves as a side effect of that iteration reaching the
 * terminal event — it is not an independent execution path.
 */
export class MockAgentRun implements AgentRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<NormalizedAgentEvent>;

  readonly #guard = new TerminalEventGuard();
  readonly #controller = new AbortController();
  #cancellationRecorded = false;
  #cancelledBy: CancelledBy = "system";
  #cancelReason: string | undefined;
  #completionResolve!: (event: NormalizedAgentEvent) => void;
  readonly #completionPromise: Promise<NormalizedAgentEvent>;
  #externalSignalCleanup: (() => void) | undefined;

  constructor(input: AgentTaskInput, config: MockAgentConfig, externalSignal?: AbortSignal) {
    this.runId = input.runId;
    this.#completionPromise = new Promise((resolve) => {
      this.#completionResolve = resolve;
    });

    if (externalSignal) {
      if (externalSignal.aborted) {
        this.#recordCancellation("system", undefined);
      } else {
        const onExternalAbort = (): void => {
          this.#recordCancellation("system", undefined);
        };
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        // If this run reaches a terminal state some other way (natural
        // completion/failure, or explicit cancel()), this listener would
        // otherwise sit on the *caller's* signal forever, keeping this run
        // (and everything it closes over) alive for as long as that signal
        // does — a real leak if Hall Runner reuses one long-lived signal
        // across many sequential runs. #resolveCompletion always tears it
        // down, regardless of which path reached the terminal state.
        this.#externalSignalCleanup = () => {
          externalSignal.removeEventListener("abort", onExternalAbort);
        };
      }
    }

    const factory = new EventFactory({
      runId: input.runId,
      taskId: input.hallTask.taskId,
      agentId: input.agentIdentity.agentId,
    });
    this.events = this.#run(config, factory);
  }

  get currentState(): RunTerminalState {
    const terminal = this.#guard.terminalEvent;
    if (!terminal) return "running";
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

  #recordCancellation(cancelledBy: CancelledBy, reason: string | undefined): void {
    if (this.#cancellationRecorded) return;
    this.#cancellationRecorded = true;
    this.#cancelledBy = cancelledBy;
    this.#cancelReason = reason;
    this.#controller.abort(reason);
  }

  #buildCancelledEvent(factory: EventFactory): NormalizedAgentEvent | undefined {
    try {
      return this.#guard.guardEvent(factory.runCancelled(this.#cancelledBy, this.#cancelReason));
    } catch (error) {
      if (error instanceof EventAfterTerminationError) return undefined;
      throw error;
    }
  }

  #finishCancelled(factory: EventFactory): NormalizedAgentEvent | undefined {
    const event = this.#buildCancelledEvent(factory);
    if (event) this.#resolveCompletion(event);
    return event;
  }

  #resolveCompletion(event: NormalizedAgentEvent): void {
    this.#completionResolve(event);
    this.#externalSignalCleanup?.();
    this.#externalSignalCleanup = undefined;
  }

  async *#run(
    config: MockAgentConfig,
    factory: EventFactory,
  ): AsyncGenerator<NormalizedAgentEvent> {
    const signal = this.#controller.signal;

    // Immediate abort: the signal was already aborted before this
    // generator's first step ran. Documented policy (matches the SDK
    // spec's suggested default): do not emit run.started at all, emit
    // exactly one run.cancelled terminal event.
    if (isAborted(signal)) {
      const event = this.#finishCancelled(factory);
      if (event) yield event;
      return;
    }

    yield this.#guard.guardEvent(factory.runStarted());

    for (let i = 0; i < config.progressMessageCount; i += 1) {
      await delay(config.stepDelayMs, signal);
      if (isAborted(signal)) {
        const event = this.#finishCancelled(factory);
        if (event) yield event;
        return;
      }
      yield this.#guard.guardEvent(
        factory.messageDelta(
          `Working... (${String(i + 1)}/${String(config.progressMessageCount)})`,
        ),
      );
    }

    await delay(config.stepDelayMs, signal);
    if (isAborted(signal)) {
      const event = this.#finishCancelled(factory);
      if (event) yield event;
      return;
    }

    if (config.scenario === "failure") {
      const failed = this.#guard.guardEvent(
        factory.runFailed({
          code: "MOCK_EXECUTION_FAILED",
          message: "The mock agent simulated a failure for this scenario.",
          retryable: config.failureRetryable,
        }),
      );
      this.#resolveCompletion(failed);
      yield failed;
      return;
    }

    yield this.#guard.guardEvent(factory.toolStarted("mock-tool-call-1", "mock_tool"));

    await delay(config.stepDelayMs, signal);
    if (isAborted(signal)) {
      const event = this.#finishCancelled(factory);
      if (event) yield event;
      return;
    }

    yield this.#guard.guardEvent(
      factory.toolCompleted("mock-tool-call-1", "mock_tool", true, "mock tool output"),
    );

    const completed = this.#guard.guardEvent(factory.runCompleted(config.completionSummary));
    this.#resolveCompletion(completed);
    yield completed;
  }
}
