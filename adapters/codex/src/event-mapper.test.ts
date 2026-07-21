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
  const factory = new EventFactory({ runId: "run-1", taskId: "task-1", agentId: "codex" });
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

  it("maps tool-started to tool.started with the fixed generic tool name", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({ kind: "tool-started", itemId: "item_1" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool.started");
    expect(events[0]?.type === "tool.started" && events[0].payload.toolCallId).toBe("item_1");
    expect(events[0]?.type === "tool.started" && events[0].payload.toolName).toBe("Codex command");
  });

  it("maps a matching tool-completed to tool.completed", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({ kind: "tool-started", itemId: "item_1" });
    const events = mapper.mapMessage({ kind: "tool-completed", itemId: "item_1", success: true });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool.completed");
    expect(events[0]?.type === "tool.completed" && events[0].payload.success).toBe(true);
    expect(events[0]?.type === "tool.completed" && events[0].payload.output).toBeUndefined();
  });

  it("maps a real sandbox-declined completion (success: false) faithfully", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({ kind: "tool-started", itemId: "item_1" });
    const events = mapper.mapMessage({ kind: "tool-completed", itemId: "item_1", success: false });
    expect(events[0]?.type === "tool.completed" && events[0].payload.success).toBe(false);
  });

  it("maps result-success to run.completed", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({ kind: "result-success", summary: "done" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.completed");
  });

  it("maps result-error to run.failed with CODEX_EXECUTION_FAILED", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({ kind: "result-error", failureMessage: "it broke" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.failed");
    expect(events[0]?.type === "run.failed" && events[0].payload.failure.code).toBe(
      "CODEX_EXECUTION_FAILED",
    );
  });

  it("maps ignored to no events", () => {
    const { mapper } = makeMapper();
    expect(mapper.mapMessage({ kind: "ignored" })).toEqual([]);
  });
});

describe("EventMapper — tool correlation", () => {
  it("does not emit tool.completed for an unknown item id (never started)", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({
      kind: "tool-completed",
      itemId: "never-started",
      success: true,
    });
    expect(events).toEqual([]);
  });

  it("does not duplicate tool.started for a repeated started event on the same item id", () => {
    const { mapper } = makeMapper();
    const first = mapper.mapMessage({ kind: "tool-started", itemId: "item_1" });
    const second = mapper.mapMessage({ kind: "tool-started", itemId: "item_1" });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("does not duplicate tool.completed for a repeated completion on the same item id", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({ kind: "tool-started", itemId: "item_1" });
    const first = mapper.mapMessage({ kind: "tool-completed", itemId: "item_1", success: true });
    const second = mapper.mapMessage({ kind: "tool-completed", itemId: "item_1", success: true });
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("never reuses the provider item id as the Hall event's own eventId", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({ kind: "tool-started", itemId: "item_1" });
    expect(events[0]?.eventId).not.toBe("item_1");
  });

  it("accounts for multiple concurrent unfinished tool calls without crashing", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({ kind: "tool-started", itemId: "item_1" });
    mapper.mapMessage({ kind: "tool-started", itemId: "item_2" });
    const events = mapper.mapMessage({ kind: "tool-completed", itemId: "item_1", success: true });
    expect(events).toHaveLength(1);
  });

  it("never emits a raw command string or command output through any mapped event", () => {
    const { mapper } = makeMapper();
    const events = [
      ...mapper.mapMessage({ kind: "tool-started", itemId: "item_1" }),
      ...mapper.mapMessage({ kind: "tool-completed", itemId: "item_1", success: false }),
    ];
    expect(JSON.stringify(events)).not.toMatch(/rm -rf|blocked by policy|Add-Content/);
  });
});

describe("EventMapper — file.changed (speculative shape, exercised for tolerance and path safety only)", () => {
  it("emits file.changed for a safe relative path with the reported change kind", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({
      kind: "file-change",
      itemId: "item_5",
      rawPath: "src\\new.ts",
      changeKind: "created",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("file.changed");
    expect(events[0]?.type === "file.changed" && events[0].payload.path).toBe("src/new.ts");
    expect(events[0]?.type === "file.changed" && events[0].payload.operation).toBe("created");
  });

  it("never exposes an absolute path in file.changed", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({
      kind: "file-change",
      itemId: "item_5",
      rawPath: "D:\\fixture\\workdir\\src\\a.ts",
      changeKind: "modified",
    });
    expect(events[0]?.type === "file.changed" && events[0].payload.path).toBe("src/a.ts");
  });

  it("omits file.changed when the reported path escapes the working directory", () => {
    const { mapper } = makeMapper();
    const events = mapper.mapMessage({
      kind: "file-change",
      itemId: "item_5",
      rawPath: "..\\..\\outside.ts",
      changeKind: "modified",
    });
    expect(events).toEqual([]);
  });

  it("deduplicates an identical repeated file-change report for the same item/path/kind", () => {
    const { mapper } = makeMapper();
    const message = {
      kind: "file-change" as const,
      itemId: "item_5",
      rawPath: "src\\a.ts",
      changeKind: "modified" as const,
    };
    const first = mapper.mapMessage(message);
    const second = mapper.mapMessage(message);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});

describe("EventMapper — terminal guard integration", () => {
  it("every emitted event validates through parseNormalizedAgentEvent", () => {
    const { mapper } = makeMapper();
    const all: unknown[] = [];
    all.push(...mapper.mapMessage({ kind: "text", text: "working" }));
    all.push(...mapper.mapMessage({ kind: "tool-started", itemId: "item_1" }));
    all.push(...mapper.mapMessage({ kind: "tool-completed", itemId: "item_1", success: true }));
    all.push(...mapper.mapMessage({ kind: "result-success", summary: "done" }));
    for (const event of all) {
      expect(() => parseNormalizedAgentEvent(event)).not.toThrow();
    }
  });

  it("sequences are contiguous starting at zero", () => {
    const { mapper } = makeMapper();
    const all: { sequence: number }[] = [];
    all.push(...mapper.mapMessage({ kind: "text", text: "a" }));
    all.push(...mapper.mapMessage({ kind: "text", text: "b" }));
    all.push(...mapper.mapMessage({ kind: "result-success" }));
    expect(all.map((e) => e.sequence)).toEqual([0, 1, 2]);
  });

  it("throws EventAfterTerminationError if mapping is attempted after a terminal event was already recorded", () => {
    const { mapper } = makeMapper();
    mapper.mapMessage({ kind: "result-success" });
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
