import { classifyNativeLine, type ParsedNativeMessage } from "./codex-native-messages.js";

export type StreamLineOutcome =
  | { readonly kind: "messages"; readonly messages: readonly ParsedNativeMessage[] }
  | { readonly kind: "malformed-json"; readonly snippet: string }
  | { readonly kind: "invalid-line"; readonly reason: string }
  | { readonly kind: "oversized-line" }
  | { readonly kind: "message-limit-reached" }
  | { readonly kind: "truncated-final-line" };

const DEFAULT_MAX_LINE_LENGTH = 1_000_000;
const DEFAULT_MAX_MESSAGES = 2000;
const SNIPPET_LENGTH = 100;

export interface StreamParserOptions {
  readonly maxLineLength?: number;
  readonly maxMessages?: number;
}

/**
 * Incrementally parses Codex's newline-delimited JSONL stdout. Handles
 * both LF and CRLF line endings, tolerates lines split across multiple
 * `push()` calls (Node stream chunk boundaries never align with message
 * boundaries), and never lets one malformed or oversized line abort
 * parsing of the rest of the stream — each line's outcome is reported
 * independently; deciding whether a given outcome is fatal for the run as
 * a whole is `CodexRun`'s job, not this parser's.
 *
 * Once `maxMessages` complete lines have been processed, every further
 * line is reported as `message-limit-reached` without being parsed —
 * this bounds both memory and total processing, independent of whatever
 * bound Hall Core's own `EventStore` applies further downstream.
 */
export class StreamParser {
  readonly #maxLineLength: number;
  readonly #maxMessages: number;
  #buffer = "";
  #processedLineCount = 0;
  #limitReached = false;

  constructor(options: StreamParserOptions = {}) {
    this.#maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
    this.#maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  }

  get processedLineCount(): number {
    return this.#processedLineCount;
  }

  /** Feeds one chunk of raw stdout text; returns the outcome for every complete line the chunk finished. */
  push(chunk: string): readonly StreamLineOutcome[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    // The last split element is either "" (chunk ended exactly on a
    // newline) or an in-progress partial line — never a complete line.
    this.#buffer = lines.pop() ?? "";

    const outcomes: StreamLineOutcome[] = [];
    for (const rawLine of lines) {
      const outcome = this.#processLine(rawLine);
      if (outcome !== undefined) outcomes.push(outcome);
    }

    // Bounds the in-progress partial line independent of whether a "\n"
    // has terminated it yet.
    if (this.#buffer.length > this.#maxLineLength) {
      outcomes.push({ kind: "oversized-line" });
      this.#buffer = "";
    }

    return outcomes;
  }

  /** Call once when the underlying stdout stream ends. Reports a truncated final line, if any. */
  flush(): readonly StreamLineOutcome[] {
    const remaining = this.#buffer;
    this.#buffer = "";
    if (remaining.trim().length === 0) return [];
    return [{ kind: "truncated-final-line" }];
  }

  #processLine(rawLine: string): StreamLineOutcome | undefined {
    // A CRLF stream leaves a trailing \r on each line after splitting on \n.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) return undefined;

    if (this.#limitReached) {
      return { kind: "message-limit-reached" };
    }

    this.#processedLineCount += 1;
    if (this.#processedLineCount > this.#maxMessages) {
      this.#limitReached = true;
      return { kind: "message-limit-reached" };
    }

    if (line.length > this.#maxLineLength) {
      return { kind: "oversized-line" };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line) as unknown;
    } catch {
      return { kind: "malformed-json", snippet: line.slice(0, SNIPPET_LENGTH) };
    }

    const classified = classifyNativeLine(parsedJson);
    if (!classified.valid) {
      return { kind: "invalid-line", reason: classified.reason };
    }
    return { kind: "messages", messages: classified.messages };
  }
}
