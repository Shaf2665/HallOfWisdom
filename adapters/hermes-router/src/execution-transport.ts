import path, { type PlatformPath } from "node:path";
import {
  HermesJsonlParser,
  HermesTransportError,
  type HermesRawEvent,
  type HermesRawTerminalEvent,
} from "./hermes-protocol.js";
import {
  nodeHermesProcessSpawner,
  type HermesProcessSpawner,
  type SpawnedHermesProcess,
} from "./execution-process.js";

export const MAX_HERMES_INPUT_BYTES = 100_000;
export const DEFAULT_HERMES_MAX_RUN_DURATION_MS = 600_000;
export const DEFAULT_HERMES_CLEANUP_GRACE_MS = 500;
export const DEFAULT_HERMES_FORCE_TERMINATION_TIMEOUT_MS = 2_000;
export const DEFAULT_HERMES_POST_EXIT_DRAIN_MS = 1_000;

const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export type HermesExecutionProcessState =
  "starting" | "running" | "terminating" | "exited" | "failed";

export interface HermesExecutionCompletion {
  readonly terminalEvent: HermesRawTerminalEvent;
  readonly exitCode: number;
  readonly signal: null;
}

export interface HermesExecutionTransportRun {
  readonly events: AsyncIterable<HermesRawEvent>;
  readonly completion: Promise<HermesExecutionCompletion>;
  readonly currentState: HermesExecutionProcessState;
  cancel(): void;
}

export interface HermesExecutionTransportOptions {
  readonly pythonExecutable: string;
  readonly runnerPath: string;
  readonly workingDirectory: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly prompt: string;
  readonly runId: string;
  /**
   * Optional routing-intent hint (e.g. "coding", "review", "general" — see
   * `task-intent.ts`) forwarded to Hermes Router as an additive `task_intent`
   * field. Deliberately just a string here, not the `TaskIntent` type: the
   * transport layer doesn't need to know the vocabulary, only forward it.
   * Omitted entirely from the wire payload when absent, so callers that
   * don't pass it (including every pre-existing test) see byte-identical
   * output to before this field existed.
   */
  readonly taskIntent?: string;
  readonly platform?: NodeJS.Platform;
  readonly spawner?: HermesProcessSpawner;
  readonly maxInputBytes?: number;
  readonly maxLineBytes?: number;
  readonly maxEventCount?: number;
  readonly maxTotalOutputBytes?: number;
  readonly maxRunDurationMs?: number;
  readonly cleanupGraceMs?: number;
  readonly forceTerminationTimeoutMs?: number;
  readonly postExitDrainMs?: number;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter({ value: item, done: false });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function pathApiForPlatform(platform: NodeJS.Platform): PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function boundedDuration(value: number | undefined, maximum: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(value, maximum)
    : maximum;
}

function containsTraversalOrNull(filePath: string): boolean {
  return filePath.includes("\0") || filePath.split(/[\\/]/u).includes("..");
}

function serializeInput(
  options: HermesExecutionTransportOptions,
  platform: NodeJS.Platform,
): Buffer {
  const pathApi = pathApiForPlatform(platform);
  if (
    options.pythonExecutable.trim().length === 0 ||
    !pathApi.isAbsolute(options.runnerPath) ||
    pathApi.basename(options.runnerPath) !== "hermes_agent_runner.py" ||
    containsTraversalOrNull(options.runnerPath) ||
    !pathApi.isAbsolute(options.workingDirectory) ||
    containsTraversalOrNull(options.workingDirectory) ||
    options.prompt.trim().length === 0 ||
    !SAFE_RUN_ID_PATTERN.test(options.runId)
  ) {
    throw new HermesTransportError(
      "HERMES_TRANSPORT_INVALID_INPUT",
      "Hermes transport configuration or task input is invalid.",
    );
  }

  const payload: Record<string, string> = { prompt: options.prompt, run_id: options.runId };
  if (options.taskIntent !== undefined) payload.task_intent = options.taskIntent;
  const input = Buffer.from(JSON.stringify(payload), "utf8");
  const maxInputBytes =
    options.maxInputBytes !== undefined &&
    Number.isInteger(options.maxInputBytes) &&
    options.maxInputBytes > 0
      ? Math.min(options.maxInputBytes, MAX_HERMES_INPUT_BYTES)
      : MAX_HERMES_INPUT_BYTES;
  if (input.length > maxInputBytes) {
    throw new HermesTransportError(
      "HERMES_TRANSPORT_INVALID_INPUT",
      "Hermes task input exceeded the transport input limit.",
    );
  }
  return input;
}

function asBuffer(chunk: unknown): Buffer | undefined {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return undefined;
}

function safeTimer(callback: () => void, milliseconds: number): NodeJS.Timeout {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return timer;
}

/** A raw Hermes process run. It deliberately does not implement Hall's AgentRunHandle. */
export class HermesExecutionRun implements HermesExecutionTransportRun {
  readonly events: AsyncIterable<HermesRawEvent>;
  readonly completion: Promise<HermesExecutionCompletion>;

  readonly #options: HermesExecutionTransportOptions;
  readonly #platform: NodeJS.Platform;
  readonly #spawner: HermesProcessSpawner;
  readonly #parser: HermesJsonlParser;
  readonly #queue = new AsyncEventQueue<HermesRawEvent>();
  readonly #resolveCompletion: (completion: HermesExecutionCompletion) => void;
  readonly #rejectCompletion: (error: HermesTransportError) => void;
  #process: SpawnedHermesProcess | undefined;
  #state: HermesExecutionProcessState = "starting";
  #failure: HermesTransportError | undefined;
  #exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  #stdoutEnded = false;
  #settled = false;
  #runTimer: NodeJS.Timeout | undefined;
  #cleanupTimer: NodeJS.Timeout | undefined;
  #forceTimer: NodeJS.Timeout | undefined;
  #drainTimer: NodeJS.Timeout | undefined;
  #cancellationRequested = false;

  readonly #onStdoutData = (chunk: unknown): void => {
    const bytes = asBuffer(chunk);
    if (bytes === undefined) {
      this.#beginFailure(
        new HermesTransportError(
          "HERMES_TRANSPORT_INVALID_UTF8",
          "Hermes stdout produced an unsupported data chunk.",
        ),
      );
      return;
    }
    const result = this.#parser.push(bytes);
    for (const event of result.events) {
      this.#queue.push(event);
      if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled"
      ) {
        this.#queue.close();
      }
    }
    if (result.error !== undefined) this.#beginFailure(result.error);
  };

  readonly #onStdoutEnd = (): void => {
    if (this.#stdoutEnded || this.#settled) return;
    this.#stdoutEnded = true;
    if (this.#drainTimer !== undefined) clearTimeout(this.#drainTimer);
    const result = this.#parser.finish();
    if (result.error !== undefined) {
      this.#beginFailure(result.error);
      return;
    }
    this.#maybeComplete();
  };

  readonly #onStderrData = (_chunk: unknown): void => {
    // Consumed only to prevent pipe backpressure. Raw stderr is never retained or exposed.
  };

  readonly #onStdinError = (): void => {
    this.#beginFailure(
      new HermesTransportError(
        "HERMES_TRANSPORT_STDIN_FAILED",
        "Hermes task input could not be delivered.",
      ),
    );
  };

  constructor(options: HermesExecutionTransportOptions) {
    this.#options = options;
    this.#platform = options.platform ?? process.platform;
    this.#spawner = options.spawner ?? nodeHermesProcessSpawner;
    this.#parser = new HermesJsonlParser({
      runId: options.runId,
      ...(options.maxLineBytes === undefined ? {} : { maxLineBytes: options.maxLineBytes }),
      ...(options.maxEventCount === undefined ? {} : { maxEventCount: options.maxEventCount }),
      ...(options.maxTotalOutputBytes === undefined
        ? {}
        : { maxTotalOutputBytes: options.maxTotalOutputBytes }),
    });
    this.events = this.#queue;

    let resolveCompletion!: (completion: HermesExecutionCompletion) => void;
    let rejectCompletion!: (error: HermesTransportError) => void;
    this.completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    this.#resolveCompletion = resolveCompletion;
    this.#rejectCompletion = rejectCompletion;
    void this.completion.catch(() => undefined);

    this.#start();
  }

  get currentState(): HermesExecutionProcessState {
    return this.#state;
  }

  cancel(): void {
    if (this.#settled || this.#cancellationRequested || this.#parser.terminalEvent !== undefined) {
      return;
    }
    this.#cancellationRequested = true;
    const child = this.#process;
    if (child === undefined || this.#exit !== undefined) return;

    this.#state = "terminating";
    try {
      child.terminate();
    } catch {
      // The bounded force phase below remains authoritative.
    }
    this.#cleanupTimer = safeTimer(
      () => {
        try {
          child.forceTerminate();
        } catch {
          // Completion remains bounded if the process already exited.
        }
        this.#forceTimer = safeTimer(
          () => {
            if (this.#settled) return;
            this.#failure = new HermesTransportError(
              "HERMES_TRANSPORT_PROCESS_EXITED",
              "Hermes execution did not stop cleanly.",
            );
            this.#queue.close();
            this.#settleFailure();
          },
          boundedDuration(
            this.#options.forceTerminationTimeoutMs,
            DEFAULT_HERMES_FORCE_TERMINATION_TIMEOUT_MS,
          ),
        );
      },
      boundedDuration(this.#options.cleanupGraceMs, DEFAULT_HERMES_CLEANUP_GRACE_MS),
    );
  }

  #start(): void {
    let input: Buffer;
    try {
      input = serializeInput(this.#options, this.#platform);
      this.#process = this.#spawner.spawn(
        this.#options.pythonExecutable,
        [this.#options.runnerPath, "run"],
        {
          cwd: this.#options.workingDirectory,
          env: this.#options.env,
          platform: this.#platform,
        },
      );
    } catch (error) {
      this.#failImmediately(
        error instanceof HermesTransportError
          ? error
          : new HermesTransportError(
              "HERMES_TRANSPORT_SPAWN_FAILED",
              "Hermes execution process could not be started.",
            ),
      );
      return;
    }

    const child = this.#process;
    this.#state = "running";
    child.stdout.on("data", this.#onStdoutData);
    child.stdout.on("end", this.#onStdoutEnd);
    child.stderr.on("data", this.#onStderrData);
    child.stdin.on("error", this.#onStdinError);
    child.onError(() => {
      this.#failImmediately(
        new HermesTransportError(
          "HERMES_TRANSPORT_SPAWN_FAILED",
          "Hermes execution process could not be started.",
        ),
      );
    });
    child.onExit((code, signal) => {
      this.#onExit(code, signal);
    });

    try {
      child.stdin.end(input);
    } catch {
      this.#onStdinError();
    }

    this.#runTimer = safeTimer(
      () => {
        this.#beginFailure(
          new HermesTransportError(
            "HERMES_TRANSPORT_TIMED_OUT",
            "Hermes execution exceeded the transport duration limit.",
          ),
        );
      },
      boundedDuration(this.#options.maxRunDurationMs, DEFAULT_HERMES_MAX_RUN_DURATION_MS),
    );
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#settled) return;
    this.#exit = { code, signal };
    if (this.#runTimer !== undefined) clearTimeout(this.#runTimer);
    if (this.#failure !== undefined) {
      this.#settleFailure();
      return;
    }
    if (this.#stdoutEnded) {
      this.#maybeComplete();
      return;
    }
    this.#drainTimer = safeTimer(
      () => {
        this.#stdoutEnded = true;
        const result = this.#parser.finish();
        if (result.error !== undefined) this.#beginFailure(result.error);
        else this.#maybeComplete();
      },
      boundedDuration(this.#options.postExitDrainMs, DEFAULT_HERMES_POST_EXIT_DRAIN_MS),
    );
  }

  #maybeComplete(): void {
    if (
      this.#settled ||
      this.#failure !== undefined ||
      !this.#stdoutEnded ||
      this.#exit === undefined
    )
      return;

    const terminalEvent = this.#parser.terminalEvent;
    if (terminalEvent === undefined || this.#exit.code === null || this.#exit.signal !== null) {
      this.#beginFailure(
        new HermesTransportError(
          "HERMES_TRANSPORT_PROCESS_EXITED",
          "Hermes execution exited inconsistently with its event stream.",
        ),
      );
      return;
    }
    const validExit =
      (terminalEvent.type === "run.failed" && this.#exit.code !== 0) ||
      (terminalEvent.type !== "run.failed" && this.#exit.code === 0);
    if (!validExit) {
      this.#beginFailure(
        new HermesTransportError(
          "HERMES_TRANSPORT_PROCESS_EXITED",
          "Hermes execution exited inconsistently with its event stream.",
        ),
      );
      return;
    }

    this.#settled = true;
    this.#state = "exited";
    this.#queue.close();
    this.#clearTimersAndListeners();
    this.#resolveCompletion({ terminalEvent, exitCode: this.#exit.code, signal: null });
  }

  #beginFailure(error: HermesTransportError): void {
    if (this.#settled || this.#failure !== undefined) return;
    this.#failure = error;
    this.#queue.close();
    if (this.#runTimer !== undefined) clearTimeout(this.#runTimer);
    if (this.#drainTimer !== undefined) clearTimeout(this.#drainTimer);

    const child = this.#process;
    if (child === undefined || this.#exit !== undefined) {
      this.#settleFailure();
      return;
    }

    this.#state = "terminating";
    if (this.#cleanupTimer !== undefined) return;
    try {
      child.terminate();
    } catch {
      // The bounded force phase below remains authoritative.
    }
    this.#cleanupTimer = safeTimer(
      () => {
        try {
          child.forceTerminate();
        } catch {
          // Completion is still bounded even if the OS reports the process already gone.
        }
        this.#forceTimer = safeTimer(
          () => {
            this.#settleFailure();
          },
          boundedDuration(
            this.#options.forceTerminationTimeoutMs,
            DEFAULT_HERMES_FORCE_TERMINATION_TIMEOUT_MS,
          ),
        );
      },
      boundedDuration(this.#options.cleanupGraceMs, DEFAULT_HERMES_CLEANUP_GRACE_MS),
    );
  }

  #failImmediately(error: HermesTransportError): void {
    if (this.#settled) return;
    this.#failure = error;
    this.#settleFailure();
  }

  #settleFailure(): void {
    if (this.#settled) return;
    const error =
      this.#failure ??
      new HermesTransportError(
        "HERMES_TRANSPORT_PROCESS_EXITED",
        "Hermes execution transport failed.",
      );
    this.#settled = true;
    this.#state = "failed";
    this.#queue.close();
    this.#clearTimersAndListeners();
    this.#rejectCompletion(error);
  }

  #clearTimersAndListeners(): void {
    for (const timer of [this.#runTimer, this.#cleanupTimer, this.#forceTimer, this.#drainTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.#process?.stdout.removeListener("data", this.#onStdoutData);
    this.#process?.stdout.removeListener("end", this.#onStdoutEnd);
    this.#process?.stderr.removeListener("data", this.#onStderrData);
    this.#process?.stdin.removeListener("error", this.#onStdinError);
  }
}

export function startHermesExecutionTransport(
  options: HermesExecutionTransportOptions,
): HermesExecutionRun {
  return new HermesExecutionRun(options);
}
