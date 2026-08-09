import { EventFactory, TerminalEventGuard } from "@hall-of-wisdom/agent-adapter-sdk";
import { describe, expect, it } from "vitest";
import { HermesEventMapper, HermesEventMappingError } from "./event-mapper.js";
import { HERMES_PROTOCOL_VERSION, type HermesRawEvent } from "./hermes-protocol.js";

function rawEvent(
  sequence: number,
  type: HermesRawEvent["type"],
  payload: Readonly<Record<string, unknown>>,
): HermesRawEvent {
  return {
    protocol: HERMES_PROTOCOL_VERSION,
    runtime_version: "0.1.0",
    run_id: "run-1",
    sequence,
    type,
    payload,
  };
}

function mapper(): HermesEventMapper {
  return new HermesEventMapper(
    new EventFactory({ runId: "run-1", taskId: "task-1", agentId: "hermes-router" }),
    new TerminalEventGuard(),
  );
}

describe("HermesEventMapper", () => {
  it("maps every non-failure event and translates snake_case with Hall sequencing", () => {
    const subject = mapper();
    const events = [
      subject.mapEvent(rawEvent(0, "run.started", {})),
      subject.mapEvent(rawEvent(1, "message.delta", { text: "Hello 🚀" })),
      subject.mapEvent(
        rawEvent(2, "tool.started", { tool_call_id: "call-1", tool_name: "project_read" }),
      ),
      subject.mapEvent(
        rawEvent(3, "tool.completed", {
          tool_call_id: "call-1",
          tool_name: "project_read",
          success: true,
          output: "raw tool output must not escape",
        }),
      ),
      subject.mapEvent(rawEvent(4, "file.changed", { path: "src\\app.ts", operation: "modified" })),
      subject.mapEvent(rawEvent(5, "run.completed", { summary: "Done" })),
    ];

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "tool.started",
      "tool.completed",
      "file.changed",
      "run.completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(events[2]?.payload).toEqual({ toolCallId: "call-1", toolName: "project_read" });
    expect(events[3]?.payload).toMatchObject({
      toolCallId: "call-1",
      toolName: "project_read",
      success: true,
    });
    expect(JSON.stringify(events[3])).not.toContain("raw tool output must not escape");
    expect(events[4]?.payload).toEqual({ path: "src/app.ts", operation: "modified" });
  });

  it("maps a validated Hermes failure to a stable safe Hall-local failure", () => {
    const subject = mapper();
    subject.mapEvent(rawEvent(0, "run.started", {}));
    const event = subject.mapEvent(
      rawEvent(1, "run.failed", {
        code: "ROUTER_FAILURE",
        message: "raw provider response and secret-shaped detail",
      }),
    );

    expect(event).toMatchObject({
      type: "run.failed",
      payload: {
        failure: { code: "HERMES_EXECUTION_FAILED", message: "Hermes execution failed." },
      },
    });
    expect(JSON.stringify(event)).not.toContain("raw provider response");
  });

  it("maps Hermes cancellation fields through EventFactory", () => {
    const subject = mapper();
    subject.mapEvent(rawEvent(0, "run.started", {}));
    const event = subject.mapEvent(
      rawEvent(1, "run.cancelled", {
        cancelled_by: "orchestrator",
        reason: "Requested by Hall",
      }),
    );

    expect(event).toMatchObject({
      type: "run.cancelled",
      payload: { cancelledBy: "orchestrator", reason: "Requested by Hall" },
    });
  });

  it.each(["project_read", "project_search", "project_apply_patch", "command_execute"] as const)(
    "maps the supported Hermes tool name %s",
    (toolName) => {
      const subject = mapper();
      subject.mapEvent(rawEvent(0, "run.started", {}));
      const started = subject.mapEvent(
        rawEvent(1, "tool.started", { tool_call_id: "call-1", tool_name: toolName }),
      );
      const completed = subject.mapEvent(
        rawEvent(2, "tool.completed", {
          tool_call_id: "call-1",
          tool_name: toolName,
          success: true,
        }),
      );

      expect(started.payload).toEqual({ toolCallId: "call-1", toolName });
      expect(completed.payload).toMatchObject({
        toolCallId: "call-1",
        toolName,
        success: true,
      });
    },
  );

  it.each(["tool.started", "tool.completed"] as const)(
    "rejects an arbitrary tool name in %s",
    (type) => {
      const subject = mapper();
      subject.mapEvent(rawEvent(0, "run.started", {}));
      expect(() =>
        subject.mapEvent(
          rawEvent(1, type, {
            tool_call_id: "call-1",
            tool_name: "arbitrary_provider_tool",
            ...(type === "tool.completed" ? { success: true } : {}),
          }),
        ),
      ).toThrow(HermesEventMappingError);
    },
  );

  it.each(["created", "modified"] as const)(
    "maps the supported Hermes file operation %s",
    (operation) => {
      const subject = mapper();
      subject.mapEvent(rawEvent(0, "run.started", {}));
      const event = subject.mapEvent(
        rawEvent(1, "file.changed", { path: "src/app.ts", operation }),
      );
      expect(event.payload).toEqual({ path: "src/app.ts", operation });
    },
  );

  it("rejects the unsupported deleted file operation", () => {
    const subject = mapper();
    subject.mapEvent(rawEvent(0, "run.started", {}));
    expect(() =>
      subject.mapEvent(rawEvent(1, "file.changed", { path: "src/app.ts", operation: "deleted" })),
    ).toThrow(HermesEventMappingError);
  });

  it.each([
    "/etc/passwd",
    "C:\\Windows\\system.ini",
    "C:drive-relative.ts",
    "../outside.ts",
    "src/../../outside.ts",
    ".git/config",
    "src/.GIT/index",
  ])("rejects unsafe file path %s", (unsafePath) => {
    const subject = mapper();
    subject.mapEvent(rawEvent(0, "run.started", {}));
    expect(() =>
      subject.mapEvent(rawEvent(1, "file.changed", { path: unsafePath, operation: "modified" })),
    ).toThrow(HermesEventMappingError);
  });

  it.each([
    ["run.started", { unexpected: true }],
    ["message.delta", { text: 1 }],
    ["tool.started", { tool_call_id: "call-1" }],
    ["tool.completed", { tool_call_id: "call-1", tool_name: "read", success: "yes" }],
    ["file.changed", { path: "src/app.ts", operation: "renamed" }],
    ["run.completed", { summary: "x".repeat(20_001) }],
    ["run.failed", { code: " ", message: "failed" }],
    ["run.cancelled", { cancelled_by: "admin" }],
  ] as const)("rejects malformed %s payload", (type, payload) => {
    expect(() => mapper().mapEvent(rawEvent(0, type, payload))).toThrow(HermesEventMappingError);
  });

  it("rejects every event after the first terminal", () => {
    const subject = mapper();
    subject.mapEvent(rawEvent(0, "run.started", {}));
    subject.mapEvent(rawEvent(1, "run.completed", {}));
    expect(() => subject.mapEvent(rawEvent(2, "message.delta", { text: "late" }))).toThrow(
      /already terminated/u,
    );
  });
});
