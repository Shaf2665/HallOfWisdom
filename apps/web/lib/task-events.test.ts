import { describe, expect, it } from "vitest";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { isTerminalEvent, parseAndClassifyIncomingEvent } from "./task-events";

const IDENTITY = { taskId: "task-1", runId: "run-1", agentId: "agent-1" };

function makeEvent(sequence: number, overrides: Partial<NormalizedAgentEvent> = {}): string {
  return JSON.stringify({
    protocolVersion: "0.1",
    eventId: `event-${String(sequence)}`,
    runId: IDENTITY.runId,
    taskId: IDENTITY.taskId,
    agentId: IDENTITY.agentId,
    timestamp: new Date().toISOString(),
    sequence,
    type: "message.delta",
    payload: { text: "progress" },
    ...overrides,
  });
}

describe("parseAndClassifyIncomingEvent", () => {
  it("accepts sequence zero with no prior events", () => {
    const result = parseAndClassifyIncomingEvent(makeEvent(0), [], IDENTITY);
    expect(result.kind).toBe("accepted");
  });

  it("accepts a contiguous next event", () => {
    const first = parseAndClassifyIncomingEvent(makeEvent(0), [], IDENTITY);
    expect(first.kind).toBe("accepted");
    const accepted = first.kind === "accepted" ? [first.event] : [];
    const second = parseAndClassifyIncomingEvent(makeEvent(1), accepted, IDENTITY);
    expect(second.kind).toBe("accepted");
  });

  it("ignores an exact duplicate (same sequence, same eventId)", () => {
    const first = parseAndClassifyIncomingEvent(makeEvent(0), [], IDENTITY);
    const accepted = first.kind === "accepted" ? [first.event] : [];
    const duplicate = parseAndClassifyIncomingEvent(makeEvent(0), accepted, IDENTITY);
    expect(duplicate.kind).toBe("duplicate");
  });

  it("detects a same-sequence conflicting event (different eventId)", () => {
    const first = parseAndClassifyIncomingEvent(makeEvent(0), [], IDENTITY);
    const accepted = first.kind === "accepted" ? [first.event] : [];
    const conflict = parseAndClassifyIncomingEvent(
      makeEvent(0, { eventId: "different-event-id" }),
      accepted,
      IDENTITY,
    );
    expect(conflict.kind).toBe("conflict");
  });

  it("detects a sequence gap", () => {
    const result = parseAndClassifyIncomingEvent(makeEvent(2), [], IDENTITY);
    expect(result.kind).toBe("gap");
  });

  it("rejects invalid JSON", () => {
    const result = parseAndClassifyIncomingEvent("{not json", [], IDENTITY);
    expect(result.kind).toBe("invalid");
  });

  it("rejects a JSON payload that does not match the protocol event schema", () => {
    const result = parseAndClassifyIncomingEvent(JSON.stringify({ nope: true }), [], IDENTITY);
    expect(result.kind).toBe("invalid");
  });

  it("rejects a taskId identity mismatch", () => {
    const result = parseAndClassifyIncomingEvent(
      makeEvent(0, { taskId: "wrong-task" }),
      [],
      IDENTITY,
    );
    expect(result.kind).toBe("identity-mismatch");
    expect(result.kind === "identity-mismatch" && result.field).toBe("taskId");
  });

  it("rejects a runId identity mismatch", () => {
    const result = parseAndClassifyIncomingEvent(
      makeEvent(0, { runId: "wrong-run" }),
      [],
      IDENTITY,
    );
    expect(result.kind).toBe("identity-mismatch");
    expect(result.kind === "identity-mismatch" && result.field).toBe("runId");
  });

  it("rejects an agentId identity mismatch", () => {
    const result = parseAndClassifyIncomingEvent(
      makeEvent(0, { agentId: "wrong-agent" }),
      [],
      IDENTITY,
    );
    expect(result.kind).toBe("identity-mismatch");
    expect(result.kind === "identity-mismatch" && result.field).toBe("agentId");
  });

  it("does not check runId/agentId identity until they are known (null)", () => {
    const result = parseAndClassifyIncomingEvent(makeEvent(0), [], {
      taskId: "task-1",
      runId: null,
      agentId: null,
    });
    expect(result.kind).toBe("accepted");
  });
});

describe("isTerminalEvent", () => {
  it("identifies all three terminal event types", () => {
    const base = {
      protocolVersion: "0.1" as const,
      eventId: "e",
      runId: "r",
      taskId: "t",
      agentId: "a",
      timestamp: new Date().toISOString(),
      sequence: 0,
    };
    expect(isTerminalEvent({ ...base, type: "run.completed", payload: {} })).toBe(true);
    expect(
      isTerminalEvent({
        ...base,
        type: "run.failed",
        payload: { failure: { code: "X", message: "x" } },
      }),
    ).toBe(true);
    expect(
      isTerminalEvent({ ...base, type: "run.cancelled", payload: { cancelledBy: "system" } }),
    ).toBe(true);
    expect(isTerminalEvent({ ...base, type: "run.started", payload: {} })).toBe(false);
  });
});
