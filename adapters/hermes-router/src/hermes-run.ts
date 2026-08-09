import {
  EventAfterTerminationError,
  EventFactory,
  TerminalEventGuard,
  type AgentRunHandle,
  type RunTerminalState,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import {
  type HermesExecutionTransportRun,
  type HermesExecutionTransportOptions,
} from "./execution-transport.js";
import {
  buildHermesFailure,
  HERMES_INVALID_EVENT,
  HERMES_TRANSPORT_FAILURE,
} from "./failure-codes.js";
import { HermesEventMapper, HermesEventMappingError } from "./event-mapper.js";

export type HermesExecutionTransportStarter = (
  options: HermesExecutionTransportOptions,
) => HermesExecutionTransportRun;

export interface HermesRunOptions extends HermesExecutionTransportOptions {
  readonly taskId: string;
  readonly agentId: string;
  readonly signal?: AbortSignal;
  readonly startTransport: HermesExecutionTransportStarter;
}

function boundedCancellationReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return trimmed.slice(0, 2000);
}

export class HermesRun implements AgentRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<NormalizedAgentEvent>;

  readonly #options: HermesRunOptions;
  readonly #factory: EventFactory;
  readonly #guard = new TerminalEventGuard();
  readonly #mapper: HermesEventMapper;
  readonly #completionPromise: Promise<NormalizedAgentEvent>;
  #resolveCompletion!: (event: NormalizedAgentEvent) => void;
  #transport: HermesExecutionTransportRun | undefined;
  #started = false;
  #rawTerminalSeen = false;
  #cancellationRequested = false;
  #cancelledBy: "orchestrator" | "system" = "system";
  #cancelReason: string | undefined;
  #externalSignalCleanup: (() => void) | undefined;

  constructor(options: HermesRunOptions) {
    this.#options = options;
    this.runId = options.runId;
    this.#factory = new EventFactory({
      runId: options.runId,
      taskId: options.taskId,
      agentId: options.agentId,
    });
    this.#mapper = new HermesEventMapper(this.#factory, this.#guard);
    this.#completionPromise = new Promise((resolve) => {
      this.#resolveCompletion = resolve;
    });
    this.events = { [Symbol.asyncIterator]: () => this.#iterate() };

    if (options.signal?.aborted === true) {
      this.#recordCancellation("system", undefined);
    } else if (options.signal !== undefined) {
      const signal = options.signal;
      const onAbort = () => {
        this.#recordCancellation("system", undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#externalSignalCleanup = () => {
        signal.removeEventListener("abort", onAbort);
      };
    }
  }

  get completion(): Promise<NormalizedAgentEvent> {
    return this.#completionPromise;
  }

  get currentState(): RunTerminalState {
    const terminal = this.#guard.terminalEvent;
    if (terminal === undefined) return "running";
    if (terminal.type === "run.completed") return "completed";
    if (terminal.type === "run.failed") return "failed";
    return "cancelled";
  }

  cancel(reason?: string): void {
    this.#recordCancellation("orchestrator", boundedCancellationReason(reason));
  }

  #recordCancellation(cancelledBy: "orchestrator" | "system", reason: string | undefined): void {
    if (this.#guard.isTerminated || this.#rawTerminalSeen || this.#cancellationRequested) return;
    this.#cancellationRequested = true;
    this.#cancelledBy = cancelledBy;
    this.#cancelReason = reason;
    this.#transport?.cancel();
  }

  async *#iterate(): AsyncGenerator<NormalizedAgentEvent> {
    if (this.#started) return;
    this.#started = true;

    if (this.#wasCancellationRequested()) {
      yield this.#finishCancelled();
      return;
    }

    let transport: HermesExecutionTransportRun;
    try {
      const {
        taskId: _taskId,
        agentId: _agentId,
        signal: _signal,
        startTransport,
        ...rawOptions
      } = this.#options;
      transport = startTransport(rawOptions);
      this.#transport = transport;
    } catch {
      yield this.#finishFailed(HERMES_TRANSPORT_FAILURE, "Hermes transport could not start.");
      return;
    }

    if (this.#wasCancellationRequested()) transport.cancel();

    try {
      for await (const rawEvent of transport.events) {
        if (
          rawEvent.type === "run.completed" ||
          rawEvent.type === "run.failed" ||
          rawEvent.type === "run.cancelled"
        ) {
          this.#rawTerminalSeen = true;
          continue;
        }
        yield this.#mapper.mapEvent(rawEvent);
      }

      const completion = await transport.completion;
      yield this.#finish(this.#mapper.mapEvent(completion.terminalEvent));
    } catch (error) {
      if (this.#guard.isTerminated) return;
      if (this.#wasCancellationRequested() && !this.#rawTerminalSeen) {
        yield this.#finishCancelled();
        return;
      }

      if (error instanceof HermesEventMappingError) {
        const failed = this.#guard.guardEvent(
          this.#factory.runFailed(
            buildHermesFailure(HERMES_INVALID_EVENT, "Hermes emitted an invalid event payload."),
          ),
        );
        transport.cancel();
        await transport.completion.catch(() => undefined);
        yield this.#finish(failed);
        return;
      }

      yield this.#finishFailed(HERMES_TRANSPORT_FAILURE, "Hermes execution transport failed.");
    }
  }

  #finish(event: NormalizedAgentEvent): NormalizedAgentEvent {
    this.#resolveCompletion(event);
    this.#cleanup();
    return event;
  }

  #wasCancellationRequested(): boolean {
    return this.#cancellationRequested;
  }

  #finishCancelled(): NormalizedAgentEvent {
    try {
      return this.#finish(
        this.#guard.guardEvent(this.#factory.runCancelled(this.#cancelledBy, this.#cancelReason)),
      );
    } catch (error) {
      if (error instanceof EventAfterTerminationError && this.#guard.terminalEvent !== undefined) {
        return this.#guard.terminalEvent;
      }
      throw error;
    }
  }

  #finishFailed(code: string, message: string): NormalizedAgentEvent {
    return this.#finish(
      this.#guard.guardEvent(this.#factory.runFailed(buildHermesFailure(code, message))),
    );
  }

  #cleanup(): void {
    this.#externalSignalCleanup?.();
    this.#externalSignalCleanup = undefined;
  }
}
