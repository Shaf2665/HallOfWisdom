import { TextDecoder } from "node:util";
import { z } from "zod";

export const HERMES_PROTOCOL_VERSION = "hermes-agent/v1";
export const MAX_HERMES_EVENT_BYTES = 24_000;
export const DEFAULT_MAX_HERMES_EVENT_COUNT = 2_000;
export const DEFAULT_MAX_HERMES_TOTAL_OUTPUT_BYTES = 24_000_000;

export const HERMES_RAW_EVENT_TYPES = [
  "run.started",
  "message.delta",
  "tool.started",
  "tool.completed",
  "file.changed",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;

export const HERMES_TERMINAL_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;

export type HermesRawEventType = (typeof HERMES_RAW_EVENT_TYPES)[number];
export type HermesTerminalEventType = (typeof HERMES_TERMINAL_EVENT_TYPES)[number];

export interface HermesRawEvent {
  readonly protocol: typeof HERMES_PROTOCOL_VERSION;
  readonly runtime_version: string;
  readonly run_id: string;
  readonly sequence: number;
  readonly type: HermesRawEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type HermesRawTerminalEvent = HermesRawEvent & {
  readonly type: HermesTerminalEventType;
};

export type HermesTransportErrorCode =
  | "HERMES_TRANSPORT_INVALID_INPUT"
  | "HERMES_TRANSPORT_SPAWN_FAILED"
  | "HERMES_TRANSPORT_STDIN_FAILED"
  | "HERMES_TRANSPORT_INVALID_UTF8"
  | "HERMES_TRANSPORT_MALFORMED_JSON"
  | "HERMES_TRANSPORT_INVALID_EVENT"
  | "HERMES_TRANSPORT_LINE_TOO_LARGE"
  | "HERMES_TRANSPORT_OUTPUT_LIMIT"
  | "HERMES_TRANSPORT_EVENT_LIMIT"
  | "HERMES_TRANSPORT_TRUNCATED_OUTPUT"
  | "HERMES_TRANSPORT_MISSING_TERMINAL"
  | "HERMES_TRANSPORT_DUPLICATE_TERMINAL"
  | "HERMES_TRANSPORT_OUTPUT_AFTER_TERMINAL"
  | "HERMES_TRANSPORT_PROCESS_EXITED"
  | "HERMES_TRANSPORT_TIMED_OUT";

export class HermesTransportError extends Error {
  readonly code: HermesTransportErrorCode;

  constructor(code: HermesTransportErrorCode, message: string) {
    super(message);
    this.name = "HermesTransportError";
    this.code = code;
  }
}

export const hermesRuntimeVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

const rawEventSchema = z
  .object({
    protocol: z.literal(HERMES_PROTOCOL_VERSION),
    runtime_version: hermesRuntimeVersionSchema,
    run_id: z.string(),
    sequence: z.number().int().nonnegative(),
    type: z.enum(HERMES_RAW_EVENT_TYPES),
    payload: z.record(z.unknown()),
  })
  .strict();

export interface HermesJsonlParserOptions {
  readonly runId: string;
  readonly maxLineBytes?: number;
  readonly maxEventCount?: number;
  readonly maxTotalOutputBytes?: number;
}

export interface HermesJsonlParseResult {
  readonly events: readonly HermesRawEvent[];
  readonly error?: HermesTransportError;
}

function boundedLimit(value: number | undefined, maximum: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : maximum;
}

function isTerminalEvent(event: HermesRawEvent): event is HermesRawTerminalEvent {
  return HERMES_TERMINAL_EVENT_TYPES.includes(event.type as HermesTerminalEventType);
}

/** Incremental, byte-bounded validator for Hermes' stdout JSONL protocol. */
export class HermesJsonlParser {
  readonly #runId: string;
  readonly #maxLineBytes: number;
  readonly #maxEventCount: number;
  readonly #maxTotalOutputBytes: number;
  #buffer = Buffer.alloc(0);
  #totalOutputBytes = 0;
  #expectedSequence = 0;
  #runtimeVersion: string | undefined;
  #terminalEvent: HermesRawTerminalEvent | undefined;
  #error: HermesTransportError | undefined;

  constructor(options: HermesJsonlParserOptions) {
    this.#runId = options.runId;
    this.#maxLineBytes = boundedLimit(options.maxLineBytes, MAX_HERMES_EVENT_BYTES);
    this.#maxEventCount = boundedLimit(options.maxEventCount, DEFAULT_MAX_HERMES_EVENT_COUNT);
    this.#maxTotalOutputBytes = boundedLimit(
      options.maxTotalOutputBytes,
      DEFAULT_MAX_HERMES_TOTAL_OUTPUT_BYTES,
    );
  }

  get terminalEvent(): HermesRawTerminalEvent | undefined {
    return this.#terminalEvent;
  }

  push(chunk: Buffer | string): HermesJsonlParseResult {
    if (this.#error !== undefined) return { events: [], error: this.#error };

    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.#totalOutputBytes += bytes.length;
    if (this.#totalOutputBytes > this.#maxTotalOutputBytes) {
      return this.#recordFailure(
        "HERMES_TRANSPORT_OUTPUT_LIMIT",
        "Hermes stdout exceeded the transport output limit.",
      );
    }

    const combined = this.#buffer.length === 0 ? bytes : Buffer.concat([this.#buffer, bytes]);
    const events: HermesRawEvent[] = [];
    let lineStart = 0;

    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) continue;
      let line = combined.subarray(lineStart, index);
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      const parsed = this.#parseLine(line);
      if (parsed instanceof HermesTransportError) {
        this.#error = parsed;
        this.#buffer = Buffer.alloc(0);
        return { events, error: parsed };
      }
      events.push(parsed);
      lineStart = index + 1;
    }

    this.#buffer = Buffer.from(combined.subarray(lineStart));
    if (this.#buffer.length > this.#maxLineBytes) {
      const result = this.#recordFailure(
        "HERMES_TRANSPORT_LINE_TOO_LARGE",
        "A Hermes JSONL record exceeded the protocol line limit.",
      );
      return { events, error: result.error };
    }
    return { events };
  }

  finish(): HermesJsonlParseResult {
    if (this.#error !== undefined) return { events: [], error: this.#error };
    if (this.#buffer.length > 0) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(this.#buffer);
      } catch {
        return this.#recordFailure(
          "HERMES_TRANSPORT_INVALID_UTF8",
          "Hermes stdout contained malformed UTF-8.",
        );
      }
      return this.#recordFailure(
        "HERMES_TRANSPORT_TRUNCATED_OUTPUT",
        "Hermes stdout ended with a truncated JSONL record.",
      );
    }
    if (this.#terminalEvent === undefined) {
      return this.#recordFailure(
        "HERMES_TRANSPORT_MISSING_TERMINAL",
        "Hermes stdout ended without a terminal event.",
      );
    }
    return { events: [] };
  }

  #parseLine(line: Buffer): HermesRawEvent | HermesTransportError {
    if (line.length === 0) {
      return new HermesTransportError(
        "HERMES_TRANSPORT_INVALID_EVENT",
        "Hermes stdout contained a blank JSONL record.",
      );
    }
    if (line.length > this.#maxLineBytes) {
      return new HermesTransportError(
        "HERMES_TRANSPORT_LINE_TOO_LARGE",
        "A Hermes JSONL record exceeded the protocol line limit.",
      );
    }
    if (this.#expectedSequence >= this.#maxEventCount) {
      return new HermesTransportError(
        "HERMES_TRANSPORT_EVENT_LIMIT",
        "Hermes stdout exceeded the transport event limit.",
      );
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      return new HermesTransportError(
        "HERMES_TRANSPORT_INVALID_UTF8",
        "Hermes stdout contained malformed UTF-8.",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return new HermesTransportError(
        "HERMES_TRANSPORT_MALFORMED_JSON",
        "Hermes stdout contained malformed JSON.",
      );
    }

    const validated = rawEventSchema.safeParse(parsed);
    if (!validated.success) {
      return new HermesTransportError(
        "HERMES_TRANSPORT_INVALID_EVENT",
        "Hermes stdout contained an invalid protocol event.",
      );
    }
    const event = validated.data as HermesRawEvent;

    if (event.run_id !== this.#runId) {
      return new HermesTransportError(
        "HERMES_TRANSPORT_INVALID_EVENT",
        "Hermes emitted an event for a different run.",
      );
    }
    if (event.sequence !== this.#expectedSequence) {
      return new HermesTransportError(
        "HERMES_TRANSPORT_INVALID_EVENT",
        "Hermes emitted a non-monotonic event sequence.",
      );
    }
    if (this.#expectedSequence === 0 && event.type !== "run.started") {
      return new HermesTransportError(
        "HERMES_TRANSPORT_INVALID_EVENT",
        "The first Hermes event was not run.started.",
      );
    }
    if (this.#expectedSequence > 0 && event.type === "run.started") {
      return new HermesTransportError(
        "HERMES_TRANSPORT_INVALID_EVENT",
        "Hermes emitted run.started more than once.",
      );
    }
    if (this.#runtimeVersion !== undefined && event.runtime_version !== this.#runtimeVersion) {
      return new HermesTransportError(
        "HERMES_TRANSPORT_INVALID_EVENT",
        "Hermes changed runtime versions during a run.",
      );
    }
    if (this.#terminalEvent !== undefined) {
      return new HermesTransportError(
        isTerminalEvent(event)
          ? "HERMES_TRANSPORT_DUPLICATE_TERMINAL"
          : "HERMES_TRANSPORT_OUTPUT_AFTER_TERMINAL",
        isTerminalEvent(event)
          ? "Hermes emitted more than one terminal event."
          : "Hermes emitted an event after its terminal event.",
      );
    }

    this.#runtimeVersion ??= event.runtime_version;
    this.#expectedSequence += 1;
    if (isTerminalEvent(event)) this.#terminalEvent = event;
    return event;
  }

  #recordFailure(
    code: HermesTransportErrorCode,
    message: string,
  ): HermesJsonlParseResult & { readonly error: HermesTransportError } {
    const error = new HermesTransportError(code, message);
    this.#error = error;
    this.#buffer = Buffer.alloc(0);
    return { events: [], error };
  }
}
