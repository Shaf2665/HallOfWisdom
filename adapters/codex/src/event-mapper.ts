import { EventFactory, TerminalEventGuard } from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import type { ParsedNativeMessage } from "./codex-native-messages.js";
import { toSafeRelativeFilePath } from "./file-path-safety.js";
import { buildFailure, CODEX_EXECUTION_FAILED } from "./failure-codes.js";

export interface EventMapperOptions {
  readonly workingDirectory: string;
}

const GENERIC_TOOL_NAME = "Codex command";

/**
 * Translates classified native messages into `NormalizedAgentEvent`s,
 * always through the SDK's `EventFactory` + `TerminalEventGuard` — never
 * by constructing an envelope by hand. Owns the item-ID correlation state
 * for exactly one run; a new `EventMapper` is created per `CodexRun`.
 *
 * Never emits a raw command string, raw command output, token usage, a
 * provider thread ID, or reasoning content — see
 * `docs/architecture/0009-codex-adapter.md`, "Command execution events"
 * and "File change events". `toolName` is always the fixed, generic
 * `"Codex command"` label: this adapter never learns (and never forwards)
 * what command Codex actually ran.
 */
export class EventMapper {
  readonly #factory: EventFactory;
  readonly #guard: TerminalEventGuard;
  readonly #workingDirectory: string;
  readonly #startedToolItemIds = new Set<string>();
  readonly #completedToolItemIds = new Set<string>();
  readonly #emittedFileChanges = new Set<string>();

  constructor(factory: EventFactory, guard: TerminalEventGuard, options: EventMapperOptions) {
    this.#factory = factory;
    this.#guard = guard;
    this.#workingDirectory = options.workingDirectory;
  }

  /** Maps one classified native message into zero or more Hall events, in order. */
  mapMessage(message: ParsedNativeMessage): readonly NormalizedAgentEvent[] {
    switch (message.kind) {
      case "ignored":
        return [];

      case "text":
        return [this.#guard.guardEvent(this.#factory.messageDelta(message.text))];

      case "tool-started":
        return this.#mapToolStarted(message);

      case "tool-completed":
        return this.#mapToolCompleted(message);

      case "file-change":
        return this.#mapFileChange(message);

      case "result-success":
        return [this.#guard.guardEvent(this.#factory.runCompleted(message.summary))];

      case "result-error":
        return [
          this.#guard.guardEvent(
            this.#factory.runFailed(buildFailure(CODEX_EXECUTION_FAILED, message.failureMessage)),
          ),
        ];
    }
  }

  #mapToolStarted(
    message: Extract<ParsedNativeMessage, { kind: "tool-started" }>,
  ): NormalizedAgentEvent[] {
    // Duplicate provider "started" for an item already started: never
    // emit a second tool.started for the same item ID.
    if (this.#startedToolItemIds.has(message.itemId)) return [];
    this.#startedToolItemIds.add(message.itemId);
    return [this.#guard.guardEvent(this.#factory.toolStarted(message.itemId, GENERIC_TOOL_NAME))];
  }

  #mapToolCompleted(
    message: Extract<ParsedNativeMessage, { kind: "tool-completed" }>,
  ): NormalizedAgentEvent[] {
    // Duplicate provider completion, or a completion with no matching
    // tool.started (never observed live for this item ID): never guess a
    // safe tool.completed pairing.
    if (this.#completedToolItemIds.has(message.itemId)) return [];
    if (!this.#startedToolItemIds.has(message.itemId)) return [];
    this.#completedToolItemIds.add(message.itemId);
    return [
      this.#guard.guardEvent(
        this.#factory.toolCompleted(message.itemId, GENERIC_TOOL_NAME, message.success),
      ),
    ];
  }

  #mapFileChange(
    message: Extract<ParsedNativeMessage, { kind: "file-change" }>,
  ): NormalizedAgentEvent[] {
    const safePath = toSafeRelativeFilePath(message.rawPath, this.#workingDirectory);
    if (safePath === undefined) return [];

    const dedupeKey = `${message.itemId}:${safePath}:${message.changeKind}`;
    if (this.#emittedFileChanges.has(dedupeKey)) return [];
    this.#emittedFileChanges.add(dedupeKey);

    return [this.#guard.guardEvent(this.#factory.fileChanged(safePath, message.changeKind))];
  }
}
