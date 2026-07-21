import { describe, expect, it } from "vitest";
import { classifyNativeLine } from "./codex-native-messages.js";

// Fixtures below marked "REAL" were copied verbatim in shape (with a
// sanitized thread_id and generic file paths/commands) from the two live
// isolated Codex CLI runs performed during Phase 10 reconnaissance and
// the confirmation smoke test — see docs/architecture/0009-codex-adapter.md,
// "Native JSONL mapping". Fixtures marked "SPECULATIVE" (file_change) were
// never observed live because every real write attempt was rejected by
// the sandbox; they model the best-effort documented shape and are
// exercised only for parser tolerance, not mapping correctness.

describe("classifyNativeLine — REAL: thread.started", () => {
  it("classifies thread.started as ignored (thread_id never forwarded)", () => {
    const result = classifyNativeLine({
      type: "thread.started",
      thread_id: "019f7db6-eb04-73a2-8f85-38eb7bf859fa",
    });
    expect(result).toEqual({ valid: true, messages: [{ kind: "ignored" }] });
  });
});

describe("classifyNativeLine — REAL: turn.started", () => {
  it("classifies turn.started as ignored (run.started already fired at spawn)", () => {
    const result = classifyNativeLine({ type: "turn.started" });
    expect(result).toEqual({ valid: true, messages: [{ kind: "ignored" }] });
  });
});

describe("classifyNativeLine — REAL: item.completed agent_message", () => {
  it("classifies a completed agent_message item as text", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "OK" },
    });
    expect(result).toEqual({ valid: true, messages: [{ kind: "text", text: "OK" }] });
  });

  it("ignores an agent_message with an empty text field", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "" },
    });
    expect(result).toEqual({ valid: true, messages: [] });
  });

  it("bounds an oversized agent_message text", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "x".repeat(30_000) },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      const [message] = result.messages;
      expect(message?.kind).toBe("text");
      if (message?.kind === "text") expect(message.text.length).toBeLessThanOrEqual(20_000);
    }
  });
});

describe("classifyNativeLine — REAL: command_execution lifecycle", () => {
  it("classifies item.started command_execution as tool-started", () => {
    const result = classifyNativeLine({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "pwsh -Command '...'",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    });
    expect(result).toEqual({ valid: true, messages: [{ kind: "tool-started", itemId: "item_1" }] });
  });

  it("classifies a successful completed command_execution (exit_code 0) as tool-completed success:true — real observed 'completed' status shape", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: {
        id: "item_3",
        type: "command_execution",
        command: "Get-ChildItem -Force",
        aggregated_output: "...",
        exit_code: 0,
        status: "completed",
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "tool-completed", itemId: "item_3", success: true }],
    });
  });

  it("classifies a sandbox-declined command_execution (exit_code -1, status 'declined') as tool-completed success:false — real observed rejection shape", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "Add-Content ...",
        aggregated_output: "rejected: blocked by policy",
        exit_code: -1,
        status: "declined",
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "tool-completed", itemId: "item_1", success: false }],
    });
  });

  it("classifies a nonzero exit_code as tool-completed success:false even with an unrecognized status label", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: { id: "item_9", type: "command_execution", exit_code: 1, status: "some_future_status" },
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "tool-completed", itemId: "item_9", success: false }],
    });
  });

  it("never emits the raw command string in the classified message", () => {
    const result = classifyNativeLine({
      type: "item.started",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "rm -rf /secret-path",
        status: "in_progress",
      },
    });
    expect(JSON.stringify(result)).not.toContain("rm -rf");
  });

  it("never emits aggregated_output (raw command output)", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: {
        id: "item_3",
        type: "command_execution",
        exit_code: 0,
        status: "completed",
        aggregated_output: "SECRET_TOKEN=abc123",
      },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
  });

  it("classifies item.completed with neither status nor exit_code as an empty (unmatched) result rather than guessing", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: { id: "item_x", type: "command_execution" },
    });
    expect(result).toEqual({ valid: true, messages: [] });
  });
});

describe("classifyNativeLine — REAL: turn.completed / turn.failed / error", () => {
  it("classifies turn.completed as result-success and never forwards usage", () => {
    const result = classifyNativeLine({
      type: "turn.completed",
      usage: {
        input_tokens: 9342,
        cached_input_tokens: 6912,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "result-success", summary: undefined }],
    });
    expect(JSON.stringify(result)).not.toContain("input_tokens");
  });

  it("classifies turn.failed as result-error with a bounded message", () => {
    const result = classifyNativeLine({ type: "turn.failed", message: "usage limit reached" });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "result-error", failureMessage: "usage limit reached" }],
    });
  });

  it("classifies a top-level error event as result-error", () => {
    const result = classifyNativeLine({ type: "error", message: "something went wrong" });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "result-error", failureMessage: "something went wrong" }],
    });
  });

  it("uses a fixed safe message when turn.failed carries no message field", () => {
    const result = classifyNativeLine({ type: "turn.failed" });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "result-error", failureMessage: "Codex reported a turn failure." }],
    });
  });
});

describe("classifyNativeLine — SPECULATIVE (never observed live): file_change", () => {
  it("classifies a completed file_change with a recognized change kind", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: {
        id: "item_5",
        type: "file_change",
        status: "completed",
        changes: [{ path: "NOTES.md", kind: "modify" }],
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [
        { kind: "file-change", itemId: "item_5", rawPath: "NOTES.md", changeKind: "modified" },
      ],
    });
  });

  it("defaults an unrecognized change kind label to 'modified'", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: {
        id: "item_5",
        type: "file_change",
        status: "completed",
        changes: [{ path: "x.md", kind: "something_new" }],
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [
        { kind: "file-change", itemId: "item_5", rawPath: "x.md", changeKind: "modified" },
      ],
    });
  });

  it("does not emit a file-change for a non-completed status", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: {
        id: "item_5",
        type: "file_change",
        status: "declined",
        changes: [{ path: "x.md", kind: "modify" }],
      },
    });
    expect(result).toEqual({ valid: true, messages: [] });
  });

  it("tolerates a completely different, unrecognized file_change shape without failing the line", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: { id: "item_5", type: "file_change", somethingElse: true },
    });
    expect(result).toEqual({ valid: true, messages: [] });
  });
});

describe("classifyNativeLine — unknown/future-tolerant", () => {
  it("classifies an unknown top-level type as ignored", () => {
    expect(classifyNativeLine({ type: "some.future.event" })).toEqual({
      valid: true,
      messages: [{ kind: "ignored" }],
    });
  });

  it("classifies reasoning items as ignored (never surfaced)", () => {
    const result = classifyNativeLine({
      type: "item.completed",
      item: { id: "item_2", type: "reasoning", text: "internal chain of thought" },
    });
    expect(result).toEqual({ valid: true, messages: [] });
    expect(JSON.stringify(result)).not.toContain("chain of thought");
  });

  it("classifies mcp_tool_call and web_search items as ignored", () => {
    expect(
      classifyNativeLine({ type: "item.completed", item: { id: "i1", type: "mcp_tool_call" } }),
    ).toEqual({ valid: true, messages: [] });
    expect(
      classifyNativeLine({ type: "item.completed", item: { id: "i2", type: "web_search" } }),
    ).toEqual({ valid: true, messages: [] });
  });

  it("classifies item.updated as ignored", () => {
    expect(
      classifyNativeLine({ type: "item.updated", item: { id: "i1", type: "agent_message" } }),
    ).toEqual({ valid: true, messages: [{ kind: "ignored" }] });
  });

  it("classifies an unrecognized item type inside item.started as no message rather than an error", () => {
    const result = classifyNativeLine({
      type: "item.started",
      item: { id: "item_9", type: "some_future_item_kind" },
    });
    expect(result).toEqual({ valid: true, messages: [] });
  });
});

describe("classifyNativeLine — structurally invalid", () => {
  it("rejects a non-object line", () => {
    const result = classifyNativeLine("just a string");
    expect(result.valid).toBe(false);
  });

  it("rejects an object with no string type field", () => {
    const result = classifyNativeLine({ foo: "bar" });
    expect(result.valid).toBe(false);
  });

  it("rejects null", () => {
    expect(classifyNativeLine(null).valid).toBe(false);
  });
});
