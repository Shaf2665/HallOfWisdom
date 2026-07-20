import { EventFactory, TerminalEventGuard } from "@hall-of-wisdom/agent-adapter-sdk";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import type { ParsedNativeMessage } from "./native-messages.js";
import { toSafeRelativeFilePath } from "./file-path-safety.js";
import {
  buildFailure,
  CLAUDE_EXECUTION_FAILED,
  CLAUDE_TURN_LIMIT_REACHED,
} from "./failure-codes.js";

export interface EventMapperOptions {
  readonly workingDirectory: string;
}

const MAX_PERMISSION_DENIAL_EVENTS = 10;

/**
 * Translates classified native messages into `NormalizedAgentEvent`s,
 * always through the SDK's `EventFactory` + `TerminalEventGuard` — never
 * by constructing an envelope by hand. Owns the tool-use/tool-result
 * correlation state for exactly one run; a new `EventMapper` is created
 * per `ClaudeCodeRun`, mirroring `MockAgentRun`'s one-`EventFactory`-
 * per-run discipline.
 */
export class EventMapper {
  readonly #factory: EventFactory;
  readonly #guard: TerminalEventGuard;
  readonly #workingDirectory: string;
  readonly #toolNames = new Map<string, string>();
  readonly #pendingFileEdits = new Map<string, string>();
  readonly #completedToolUseIds = new Set<string>();

  constructor(factory: EventFactory, guard: TerminalEventGuard, options: EventMapperOptions) {
    this.#factory = factory;
    this.#guard = guard;
    this.#workingDirectory = options.workingDirectory;
  }

  /** Maps one classified native message into zero or more Hall events, in order. */
  mapMessage(message: ParsedNativeMessage): readonly NormalizedAgentEvent[] {
    switch (message.kind) {
      case "system-init":
      case "ignored":
        return [];

      case "text":
        return [this.#guard.guardEvent(this.#factory.messageDelta(message.text))];

      case "tool-use":
        return this.#mapToolUse(message);

      case "tool-result":
        return this.#mapToolResult(message);

      case "result-success":
        return [
          ...this.#mapPermissionDenials(message.deniedToolNames),
          this.#guard.guardEvent(this.#factory.runCompleted(message.summary)),
        ];

      case "result-error":
        return [
          ...this.#mapPermissionDenials(message.deniedToolNames),
          this.#guard.guardEvent(this.#factory.runFailed(this.#buildResultErrorFailure(message))),
        ];
    }
  }

  #mapToolUse(message: Extract<ParsedNativeMessage, { kind: "tool-use" }>): NormalizedAgentEvent[] {
    this.#toolNames.set(message.toolUseId, message.toolName);
    if (message.rawFilePath !== undefined) {
      this.#pendingFileEdits.set(message.toolUseId, message.rawFilePath);
    }
    return [this.#guard.guardEvent(this.#factory.toolStarted(message.toolUseId, message.toolName))];
  }

  #mapToolResult(
    message: Extract<ParsedNativeMessage, { kind: "tool-result" }>,
  ): NormalizedAgentEvent[] {
    // Duplicate provider tool result for an already-completed tool use:
    // never emit a second tool.completed.
    if (this.#completedToolUseIds.has(message.toolUseId)) {
      return [];
    }

    const toolName = this.#toolNames.get(message.toolUseId);
    // Unknown/unmatched tool result ID (no tool.started was ever seen for
    // it): deterministically skipped rather than guessed at — there is no
    // safe tool name to report.
    if (toolName === undefined) {
      return [];
    }

    this.#completedToolUseIds.add(message.toolUseId);
    // No `output` argument: the provider's raw tool-result content is
    // never read by this adapter (see native-messages.ts's
    // classifyUserMessage), so there is nothing safe to forward here.
    const events: NormalizedAgentEvent[] = [
      this.#guard.guardEvent(
        this.#factory.toolCompleted(message.toolUseId, toolName, message.success),
      ),
    ];

    const rawFilePath = this.#pendingFileEdits.get(message.toolUseId);
    this.#pendingFileEdits.delete(message.toolUseId);
    if (message.success && rawFilePath !== undefined) {
      const safePath = toSafeRelativeFilePath(rawFilePath, this.#workingDirectory);
      if (safePath !== undefined) {
        // Both Edit and Write are reported as "modified": this adapter
        // has no reliable, side-effect-free way to tell whether a Write
        // call created a new file or overwrote an existing one without
        // an extra filesystem check outside this stream — a deliberate,
        // disclosed Phase 9 simplification. See
        // docs/architecture/0008-claude-code-adapter.md, "Provider-to-
        // Hall event mapping".
        events.push(this.#guard.guardEvent(this.#factory.fileChanged(safePath, "modified")));
      }
    }

    return events;
  }

  #mapPermissionDenials(deniedToolNames: readonly string[]): NormalizedAgentEvent[] {
    return deniedToolNames
      .slice(0, MAX_PERMISSION_DENIAL_EVENTS)
      .map((toolName) =>
        this.#guard.guardEvent(
          this.#factory.approvalRequired(
            `Claude Code was blocked from using a tool ("${toolName}") that is not in this task's permitted tool set.`,
            "medium",
          ),
        ),
      );
  }

  #buildResultErrorFailure(
    message: Extract<ParsedNativeMessage, { kind: "result-error" }>,
  ): ReturnType<typeof buildFailure> {
    const code =
      message.subtype === "error_max_turns" ? CLAUDE_TURN_LIMIT_REACHED : CLAUDE_EXECUTION_FAILED;
    return buildFailure(code, message.failureMessage);
  }
}
