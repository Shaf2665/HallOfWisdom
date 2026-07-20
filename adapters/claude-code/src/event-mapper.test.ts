import { describe, expect, it } from "vitest";
import {
  EventAfterTerminationError,
  EventFactory,
  TerminalEventGuard,
} from "@hall-of-wisdom/agent-adapter-sdk";
import { parseNormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { EventMapper } from "./event-mapper.js";

const WORKDIR = "D:\\fixture\\workdir";

function makeMapper() {
  const factory = new EventFactory({ runId: "run-1", taskId: "task-1", agentId: "claude-code" });
  const guard = new TerminalEventGuard();
  const mapper = new EventMapper(factory, guard, { workingDirectory: WORKDIR });
  return { mapper, guard };
}

describe("EventMapper — basic mapping", () => {
  it("maps text to message.delta", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({ kind: "text", text: "hello" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("message.delta");
    expect(events[0]?.type === "message.delta" && events[0].payload.text).toBe("hello");
    expect(() => parseNormalizedAgentEvent(events[0])).not.toThrow();
  });

  it("maps tool-use to tool.started", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({ kind: "tool-use", toolUseId: "toolu_1", toolName: "Read" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool.started");
    expect(events[0]?.type === "tool.started" && events[0].payload.toolCallId).toBe("toolu_1");
    expect(events[0]?.type === "tool.started" && events[0].payload.toolName).toBe("Read");
  });

  it("maps a matching tool-result to tool.completed", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({ kind: "tool-use", toolUseId: "toolu_1", toolName: "Read" });
    const events = mapper.mapMessage({ kind: "tool-result", toolUseId: "toolu_1", success: true });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool.completed");
    expect(events[0]?.type === "tool.completed" && events[0].payload.success).toBe(true);
    // Security-relevant: this adapter never has raw tool-result content to
    // forward (native-messages.ts's classifyUserMessage never reads it),
    // so tool.completed's optional output field must never be populated.
    expect(events[0]?.type === "tool.completed" && events[0].payload.output).toBeUndefined();
  });

  it("maps result-success to run.completed", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({
      kind: "result-success",
      summary: "done",
      deniedToolNames: [],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.completed");
  });

  it("maps result-error to run.failed with CLAUDE_EXECUTION_FAILED by default", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({
      kind: "result-error",
      failureMessage: "it broke",
      deniedToolNames: [],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.failed");
    expect(events[0]?.type === "run.failed" && events[0].payload.failure.code).toBe(
      "CLAUDE_EXECUTION_FAILED",
    );
  });

  it("maps result-error with subtype error_max_turns to CLAUDE_TURN_LIMIT_REACHED", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({
      kind: "result-error",
      failureMessage: "too many turns",
      subtype: "error_max_turns",
      deniedToolNames: [],
    });
    expect(events[0]?.type === "run.failed" && events[0].payload.failure.code).toBe(
      "CLAUDE_TURN_LIMIT_REACHED",
    );
  });

  it("maps system-init and ignored to no events", () => {
    const { mapper } = makeMapper();
    expect(mapper.mapMessage({ kind: "system-init", cwd: WORKDIR })).toEqual([]);
    expect(mapper.mapMessage({ kind: "ignored" })).toEqual([]);
  });
});

describe("EventMapper — tool correlation", () => {
  it("does not emit tool.completed for an unknown tool-result id", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({
      kind: "tool-result",
      toolUseId: "never-started",
      success: true,
    });
    expect(events).toEqual([]);
  });

  it("does not duplicate tool.completed for a repeated tool-result on the same id", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({ kind: "tool-use", toolUseId: "toolu_1", toolName: "Read" });
    const first = mapper.mapMessage({ kind: "tool-result", toolUseId: "toolu_1", success: true });
    const second = mapper.mapMessage({ kind: "tool-result", toolUseId: "toolu_1", success: true });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("never reuses the provider toolUseId as the Hall event's own eventId", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({ kind: "tool-use", toolUseId: "toolu_1", toolName: "Read" });
    expect(events[0]?.eventId).not.toBe("toolu_1");
  });

  it("accounts for multiple concurrent unfinished tool calls without crashing", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({ kind: "tool-use", toolUseId: "toolu_1", toolName: "Read" });
    mapper.mapMessage({ kind: "tool-use", toolUseId: "toolu_2", toolName: "Grep" });
    // Only toolu_1 ever gets a result; toolu_2 is left unfinished — this
    // must not throw or otherwise disrupt mapping toolu_1's result.
    const events = mapper.mapMessage({ kind: "tool-result", toolUseId: "toolu_1", success: true });
    expect(events).toHaveLength(1);
  });
});

describe("EventMapper — file.changed", () => {
  it("emits file.changed for a successful Edit/Write tool result with a safe relative path", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({
      kind: "tool-use",
      toolUseId: "toolu_1",
      toolName: "Write",
      rawFilePath: "src\\new.ts",
    });
    const events = mapper.mapMessage({ kind: "tool-result", toolUseId: "toolu_1", success: true });
    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe("file.changed");
    expect(events[1]?.type === "file.changed" && events[1].payload.path).toBe("src/new.ts");
    expect(events[1]?.type === "file.changed" && events[1].payload.operation).toBe("modified");
  });

  it("never exposes an absolute path in file.changed", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({
      kind: "tool-use",
      toolUseId: "toolu_1",
      toolName: "Edit",
      rawFilePath: "D:\\fixture\\workdir\\src\\a.ts",
    });
    const events = mapper.mapMessage({ kind: "tool-result", toolUseId: "toolu_1", success: true });
    const fileEvent = events.find((e) => e.type === "file.changed");
    expect(fileEvent?.type === "file.changed" && fileEvent.payload.path).toBe("src/a.ts");
  });

  it("does not emit file.changed when the tool failed", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({
      kind: "tool-use",
      toolUseId: "toolu_1",
      toolName: "Write",
      rawFilePath: "src\\new.ts",
    });
    const events = mapper.mapMessage({ kind: "tool-result", toolUseId: "toolu_1", success: false });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool.completed");
  });

  it("omits file.changed when the reported path escapes the working directory", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({
      kind: "tool-use",
      toolUseId: "toolu_1",
      toolName: "Write",
      rawFilePath: "..\\..\\outside.ts",
    });
    const events = mapper.mapMessage({ kind: "tool-result", toolUseId: "toolu_1", success: true });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool.completed");
  });

  it("does not emit file.changed for a non-file-editing tool such as Read", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({ kind: "tool-use", toolUseId: "toolu_1", toolName: "Read" });
    const events = mapper.mapMessage({ kind: "tool-result", toolUseId: "toolu_1", success: true });
    expect(events).toHaveLength(1);
  });
});

describe("EventMapper — permission denials", () => {
  it("emits approval.required before run.completed for each denied tool", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({
      kind: "result-success",
      summary: "done",
      deniedToolNames: ["WebFetch", "Docker"],
    });
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe("approval.required");
    expect(events[1]?.type).toBe("approval.required");
    expect(events[2]?.type).toBe("run.completed");
  });

  it("emits approval.required before run.failed for each denied tool", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({
      kind: "result-error",
      failureMessage: "failed",
      deniedToolNames: ["Docker"],
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("approval.required");
    expect(events[1]?.type).toBe("run.failed");
  });

  it("emits no approval.required events when nothing was denied", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({
      kind: "result-success",
      summary: "done",
      deniedToolNames: [],
    });
    expect(events).toHaveLength(1);
  });
});

describe("EventMapper — terminal guard integration", () => {
  it("every emitted event validates through parseNormalizedAgentEvent", () => {
    const { mapper } = makeMapper();
    const all: unknown[] = [];
    all.push(...mapper.mapMessage({ kind: "text", text: "working" }));
    all.push(...mapper.mapMessage({ kind: "tool-use", toolUseId: "t1", toolName: "Read" }));
    all.push(...mapper.mapMessage({ kind: "tool-result", toolUseId: "t1", success: true }));
    all.push(
      ...mapper.mapMessage({ kind: "result-success", summary: "done", deniedToolNames: [] }),
    );
    for (const event of all) {
      expect(() => parseNormalizedAgentEvent(event)).not.toThrow();
    }
  });

  it("sequences are contiguous starting at zero", () => {
    const { mapper } = makeMapper();
    const all: { sequence: number }[] = [];
    all.push(...mapper.mapMessage({ kind: "text", text: "a" }));
    all.push(...mapper.mapMessage({ kind: "text", text: "b" }));
    all.push(
      ...mapper.mapMessage({ kind: "result-success", summary: "done", deniedToolNames: [] }),
    );
    expect(all.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it("throws EventAfterTerminationError if mapping is attempted after a terminal event was already recorded", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({ kind: "result-success", summary: "done", deniedToolNames: [] });
    expect(() => mapper.mapMessage({ kind: "text", text: "too late" })).toThrow(
      EventAfterTerminationError,
    );
  });

  it("event IDs are unique across many mapped messages", () => {
    const { mapper } = makeMapper();
    const all: { eventId: string }[] = [];
    for (let i = 0; i < 5; i += 1) {
      all.push(...mapper.mapMessage({ kind: "text", text: `msg-${String(i)}` }));
    }
    const ids = new Set(all.map((e) => e.eventId));
    expect(ids.size).toBe(5);
  });
});
