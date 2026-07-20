import { describe, expect, it } from "vitest";
import { classifyNativeLine } from "./native-messages.js";

// Fixtures in the first two describe blocks are sanitized shapes actually
// observed from a real zero-tool `claude -p ... --output-format
// stream-json` probe against the installed CLI (2.1.212) — session IDs,
// account/org details, and absolute paths have been replaced with
// placeholders; the structural shape (field names/types) is real.
// tool_use/tool_result fixtures further below were not observed by that
// probe (it used `--tools ""`) and are built from documented Claude Code
// stream-json shapes — see docs/architecture/0008-claude-code-adapter.md,
// "Native stream mapping", for which shapes are probe-confirmed vs.
// documented-but-unverified until the real smoke test.

describe("classifyNativeLine — real captured system/rate-limit shapes", () => {
  it("ignores a system/hook_started message", () => {
    const result = classifyNativeLine({
      type: "system",
      subtype: "hook_started",
      hook_id: "56928b14-3903-41fe-bfc8-4dc8be1cb9ee",
      hook_name: "SessionStart:startup",
      hook_event: "SessionStart",
      uuid: "768bac09-e0d1-4394-8a2f-65f1b6b82548",
      session_id: "session-placeholder",
    });
    expect(result.valid).toBe(true);
    expect(result).toEqual({ valid: true, messages: [{ kind: "ignored" }] });
  });

  it("ignores a system/hook_response message even when it reports an error outcome", () => {
    const result = classifyNativeLine({
      type: "system",
      subtype: "hook_response",
      hook_id: "8db9d0bd-e1d8-48d1-9601-641cd0ac2a29",
      output: "some hook error text",
      stderr: "some hook error text",
      exit_code: 1,
      outcome: "error",
      session_id: "session-placeholder",
    });
    expect(result).toEqual({ valid: true, messages: [{ kind: "ignored" }] });
  });

  it("extracts only cwd from a system/init message, never the rest of the payload", () => {
    const result = classifyNativeLine({
      type: "system",
      subtype: "init",
      cwd: "D:\\fixture\\workdir",
      session_id: "session-placeholder",
      tools: [],
      mcp_servers: [],
      model: "claude-sonnet-5",
      permissionMode: "dontAsk",
      slash_commands: ["graphify", "superpowers:brainstorming"],
      agents: ["claude", "Explore"],
      plugins: [{ name: "frontend-design", path: "C:\\Users\\redacted\\plugins\\frontend-design" }],
      memory_paths: { auto: "C:\\Users\\redacted\\projects\\redacted\\memory\\" },
      apiKeySource: "none",
      claude_code_version: "2.1.212",
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "system-init", cwd: "D:\\fixture\\workdir" }],
    });
  });

  it("ignores a rate_limit_event message", () => {
    const result = classifyNativeLine({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1784262000,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        isUsingOverage: false,
      },
      uuid: "24df22ca-fdd6-4f4b-baa3-66babe7ff719",
      session_id: "session-placeholder",
    });
    expect(result).toEqual({ valid: true, messages: [{ kind: "ignored" }] });
  });

  it("ignores an unknown/future system subtype rather than failing", () => {
    const result = classifyNativeLine({ type: "system", subtype: "some_future_subtype" });
    expect(result).toEqual({ valid: true, messages: [{ kind: "ignored" }] });
  });

  it("ignores an entirely unrecognized type rather than failing", () => {
    const result = classifyNativeLine({ type: "some_future_message_type", data: { a: 1 } });
    expect(result).toEqual({ valid: true, messages: [{ kind: "ignored" }] });
  });
});

describe("classifyNativeLine — real captured assistant/result shapes", () => {
  it("classifies an assistant text-only message", () => {
    const result = classifyNativeLine({
      type: "assistant",
      message: {
        model: "claude-sonnet-5",
        id: "msg_placeholder",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "PROBE_OK" }],
        stop_reason: null,
        usage: { input_tokens: 2, output_tokens: 1 },
      },
      parent_tool_use_id: null,
      session_id: "session-placeholder",
      uuid: "uuid-placeholder",
      timestamp: "2026-07-17T03:44:41.383Z",
    });
    expect(result).toEqual({ valid: true, messages: [{ kind: "text", text: "PROBE_OK" }] });
  });

  it("classifies a successful result message and extracts only the bounded result text", () => {
    const result = classifyNativeLine({
      type: "result",
      subtype: "success",
      is_error: false,
      api_error_status: null,
      duration_ms: 2400,
      result: "PROBE_OK",
      stop_reason: "end_turn",
      session_id: "session-placeholder",
      total_cost_usd: 0.0495765,
      usage: { input_tokens: 2, output_tokens: 9 },
      permission_denials: [],
      terminal_reason: "completed",
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "result-success", summary: "PROBE_OK", deniedToolNames: [] }],
    });
  });

  it("never surfaces total_cost_usd, usage, or session_id from the result message", () => {
    const result = classifyNativeLine({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      total_cost_usd: 99.99,
      usage: { input_tokens: 1000000 },
      session_id: "should-never-appear",
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "result-success", summary: "done", deniedToolNames: [] }],
    });
    expect(JSON.stringify(result)).not.toContain("99.99");
    expect(JSON.stringify(result)).not.toContain("should-never-appear");
  });

  it("classifies a failing result message (is_error true) as result-error", () => {
    const result = classifyNativeLine({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "The run could not complete.",
    });
    expect(result).toEqual({
      valid: true,
      messages: [
        {
          kind: "result-error",
          failureMessage: "The run could not complete.",
          subtype: "error_max_turns",
          deniedToolNames: [],
        },
      ],
    });
  });

  it("falls back to a generic failure message when an error result has no result text", () => {
    const result = classifyNativeLine({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.messages[0]).toEqual({
        kind: "result-error",
        failureMessage: "error_during_execution",
        subtype: "error_during_execution",
        deniedToolNames: [],
      });
    }
  });

  it("extracts denied tool names from a successful result's permission_denials array", () => {
    const result = classifyNativeLine({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      permission_denials: [{ tool_name: "WebFetch" }, { tool_name: "Bash" }],
    });
    expect(result).toEqual({
      valid: true,
      messages: [
        { kind: "result-success", summary: "done", deniedToolNames: ["WebFetch", "Bash"] },
      ],
    });
  });

  it("bounds permission_denials extraction and never leaks unrelated denial fields", () => {
    const manyDenials = Array.from({ length: 20 }, (_, i) => ({
      tool_name: `Tool${String(i)}`,
      raw_command: "SECRET_COMMAND",
    }));
    const result = classifyNativeLine({
      type: "result",
      subtype: "success",
      is_error: false,
      permission_denials: manyDenials,
    });
    expect(result.valid).toBe(true);
    if (result.valid && result.messages[0]?.kind === "result-success") {
      expect(result.messages[0].deniedToolNames.length).toBeLessThanOrEqual(10);
    }
    expect(JSON.stringify(result)).not.toContain("SECRET_COMMAND");
  });

  it("tolerates a missing or malformed permission_denials field", () => {
    const result = classifyNativeLine({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "result-success", summary: "done", deniedToolNames: [] }],
    });
  });

  it("reports a result message missing is_error as an invalid line", () => {
    const result = classifyNativeLine({ type: "result", subtype: "success", result: "done" });
    expect(result.valid).toBe(false);
  });
});

// These fixtures were originally built from documented Claude Code
// stream-json shapes rather than a live probe (the initial zero-tool
// reconnaissance probe used --tools "" and so never exercised a tool
// call). Phase 9's real isolated smoke task (a real Read then Edit
// against a throwaway fixture, driven through the actual
// ClaudeCodeAdapter) subsequently exercised this exact path end to end —
// tool.started/tool.completed emitted correctly and file.changed resolved
// the real edited path — confirming these shapes match live behavior.
describe("classifyNativeLine — tool_use/tool_result shapes (live-verified via real smoke task)", () => {
  it("classifies an assistant tool_use content block", () => {
    const result = classifyNativeLine({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_01abc", name: "Read", input: { file_path: "a.ts" } },
        ],
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "tool-use", toolUseId: "toolu_01abc", toolName: "Read" }],
    });
  });

  it("classifies mixed text and tool_use blocks in one assistant message, preserving order", () => {
    const result = classifyNativeLine({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me check that file." },
          { type: "tool_use", id: "toolu_02", name: "Read", input: {} },
        ],
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [
        { kind: "text", text: "Let me check that file." },
        { kind: "tool-use", toolUseId: "toolu_02", toolName: "Read" },
      ],
    });
  });

  it("never exposes raw tool_use input", () => {
    const result = classifyNativeLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_03",
            name: "Bash",
            input: { command: "echo SECRET_TOKEN=abc123" },
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(result)).not.toContain("echo");
  });

  // Provider tool-result content (file contents, command stdout, anything
  // a real tool produced) must never be forwarded into a Hall event, even
  // truncated — see docs/architecture/0008-claude-code-adapter.md,
  // "Provider-to-Hall event mapping". These tests assert the classified
  // message never carries any part of `content`, regardless of its shape.

  it("classifies a successful user/tool_result content block without forwarding its content", () => {
    const result = classifyNativeLine({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01abc",
            content: "file contents here",
            is_error: false,
          },
        ],
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "tool-result", toolUseId: "toolu_01abc", success: true }],
    });
    expect(JSON.stringify(result)).not.toContain("file contents here");
  });

  it("classifies a failing user/tool_result content block without forwarding its content", () => {
    const result = classifyNativeLine({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_04",
            content: "permission denied",
            is_error: true,
          },
        ],
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "tool-result", toolUseId: "toolu_04", success: false }],
    });
    expect(JSON.stringify(result)).not.toContain("permission denied");
  });

  it("never forwards an oversized tool_result content string", () => {
    const result = classifyNativeLine({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_05",
            content: "x".repeat(5000),
            is_error: false,
          },
        ],
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "tool-result", toolUseId: "toolu_05", success: true }],
    });
  });

  it("never forwards a non-string, non-text-block content shape", () => {
    const result = classifyNativeLine({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_06",
            content: { weird: "shape" },
            is_error: false,
          },
        ],
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "tool-result", toolUseId: "toolu_06", success: true }],
    });
  });

  it("never forwards a text block from array-shaped tool_result content", () => {
    const result = classifyNativeLine({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_07",
            content: [{ type: "text", text: "array-shaped result text" }],
            is_error: false,
          },
        ],
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [{ kind: "tool-result", toolUseId: "toolu_07", success: true }],
    });
    expect(JSON.stringify(result)).not.toContain("array-shaped result text");
  });

  it("extracts rawFilePath from input.file_path for a Write tool call", () => {
    const result = classifyNativeLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_08",
            name: "Write",
            input: { file_path: "src/new.ts", content: "export {}" },
          },
        ],
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [
        { kind: "tool-use", toolUseId: "toolu_08", toolName: "Write", rawFilePath: "src/new.ts" },
      ],
    });
  });

  it("extracts rawFilePath from input.file_path for an Edit tool call", () => {
    const result = classifyNativeLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_09",
            name: "Edit",
            input: { file_path: "src/existing.ts", old_string: "a", new_string: "b" },
          },
        ],
      },
    });
    expect(result).toEqual({
      valid: true,
      messages: [
        {
          kind: "tool-use",
          toolUseId: "toolu_09",
          toolName: "Edit",
          rawFilePath: "src/existing.ts",
        },
      ],
    });
  });

  it("never extracts rawFilePath for a non-file-editing tool such as Bash", () => {
    const result = classifyNativeLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_10",
            name: "Bash",
            input: { file_path: "irrelevant.ts", command: "ls" },
          },
        ],
      },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      const message = result.messages[0];
      expect(message?.kind).toBe("tool-use");
      if (message?.kind === "tool-use") {
        expect(message.rawFilePath).toBeUndefined();
      }
    }
  });

  it("never leaks other input fields (old_string/new_string/content/command) through rawFilePath extraction", () => {
    const result = classifyNativeLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_11",
            name: "Edit",
            input: { file_path: "a.ts", old_string: "SECRET_OLD", new_string: "SECRET_NEW" },
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_OLD");
    expect(JSON.stringify(result)).not.toContain("SECRET_NEW");
  });

  it("omits rawFilePath when a Write/Edit tool call's input has no file_path", () => {
    const result = classifyNativeLine({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_12", name: "Write", input: { content: "x" } }],
      },
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      const message = result.messages[0];
      if (message?.kind === "tool-use") {
        expect(message.rawFilePath).toBeUndefined();
      }
    }
  });

  it("ignores a tool_use block missing an id or name rather than failing the whole line", () => {
    const result = classifyNativeLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read" }] },
    });
    expect(result).toEqual({ valid: true, messages: [] });
  });

  it("ignores an assistant thinking block", () => {
    const result = classifyNativeLine({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "internal reasoning text" }] },
    });
    expect(result).toEqual({ valid: true, messages: [] });
  });
});

describe("classifyNativeLine — malformed input", () => {
  it("reports a non-object line as invalid", () => {
    expect(classifyNativeLine("just a string").valid).toBe(false);
  });

  it("reports null as invalid", () => {
    expect(classifyNativeLine(null).valid).toBe(false);
  });

  it("reports an object with no type field as invalid", () => {
    expect(classifyNativeLine({ foo: "bar" }).valid).toBe(false);
  });

  it("reports an object with a non-string type field as invalid", () => {
    expect(classifyNativeLine({ type: 123 }).valid).toBe(false);
  });

  it("handles an assistant message with a missing content array safely", () => {
    const result = classifyNativeLine({ type: "assistant", message: {} });
    expect(result).toEqual({ valid: true, messages: [] });
  });

  it("handles an assistant message with a missing message object safely", () => {
    const result = classifyNativeLine({ type: "assistant" });
    expect(result).toEqual({ valid: true, messages: [] });
  });
});
