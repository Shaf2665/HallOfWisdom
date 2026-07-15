import { describe, expect, it } from "vitest";
import {
  normalizedAgentEventSchema,
  parseNormalizedAgentEvent,
  runStartedEventSchema,
  messageDeltaEventSchema,
  toolStartedEventSchema,
  toolCompletedEventSchema,
  fileChangedEventSchema,
  approvalRequiredEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  runCancelledEventSchema,
} from "./events.js";

const envelope = {
  protocolVersion: "0.1" as const,
  eventId: "event-1",
  runId: "run-1",
  taskId: "task-1",
  agentId: "agent-claude-1",
  timestamp: "2026-07-15T12:00:00.000Z",
  sequence: 0,
};

describe("normalized agent events", () => {
  it("accepts a run.started event", () => {
    const event = { ...envelope, type: "run.started" as const, payload: {} };
    expect(runStartedEventSchema.safeParse(event).success).toBe(true);
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a message.delta event", () => {
    const event = {
      ...envelope,
      type: "message.delta" as const,
      payload: { text: "Reading package.json..." },
    };
    expect(messageDeltaEventSchema.safeParse(event).success).toBe(true);
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a tool.started event", () => {
    const event = {
      ...envelope,
      type: "tool.started" as const,
      payload: { toolCallId: "call-1", toolName: "read_file" },
    };
    expect(toolStartedEventSchema.safeParse(event).success).toBe(true);
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a tool.completed event", () => {
    const event = {
      ...envelope,
      type: "tool.completed" as const,
      payload: { toolCallId: "call-1", toolName: "read_file", success: true },
    };
    expect(toolCompletedEventSchema.safeParse(event).success).toBe(true);
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a file.changed event", () => {
    const event = {
      ...envelope,
      type: "file.changed" as const,
      payload: { path: "src/index.ts", operation: "modified" as const },
    };
    expect(fileChangedEventSchema.safeParse(event).success).toBe(true);
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts an approval.required event", () => {
    const event = {
      ...envelope,
      type: "approval.required" as const,
      payload: { reason: "Push to protected branch", riskLevel: "high" as const },
    };
    expect(approvalRequiredEventSchema.safeParse(event).success).toBe(true);
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a run.completed event", () => {
    const event = {
      ...envelope,
      type: "run.completed" as const,
      payload: { summary: "Implemented the login page." },
    };
    expect(runCompletedEventSchema.safeParse(event).success).toBe(true);
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a run.failed event", () => {
    const event = {
      ...envelope,
      type: "run.failed" as const,
      payload: {
        failure: { code: "AGENT_CRASHED", message: "The adapter process exited unexpectedly." },
      },
    };
    expect(runFailedEventSchema.safeParse(event).success).toBe(true);
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a run.cancelled event cancelled by a user without a reason", () => {
    const event = {
      ...envelope,
      type: "run.cancelled" as const,
      payload: { cancelledBy: "user" as const },
    };
    expect(runCancelledEventSchema.safeParse(event).success).toBe(true);
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a run.cancelled event cancelled by the orchestrator with a reason", () => {
    const event = {
      ...envelope,
      type: "run.cancelled" as const,
      payload: { cancelledBy: "orchestrator" as const, reason: "Superseded by a retried run." },
    };
    expect(runCancelledEventSchema.safeParse(event).success).toBe(true);
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects a run.cancelled event with an invalid cancelledBy value", () => {
    const event = {
      ...envelope,
      type: "run.cancelled" as const,
      payload: { cancelledBy: "admin" },
    };
    expect(runCancelledEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects a run.cancelled event with a blank reason", () => {
    const event = {
      ...envelope,
      type: "run.cancelled" as const,
      payload: { cancelledBy: "system" as const, reason: "   " },
    };
    expect(runCancelledEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects a run.cancelled event with an excessively long reason", () => {
    const event = {
      ...envelope,
      type: "run.cancelled" as const,
      payload: { cancelledBy: "system" as const, reason: "x".repeat(2001) },
    };
    expect(runCancelledEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects a run.cancelled event with an unexpected payload field", () => {
    const event = {
      ...envelope,
      type: "run.cancelled" as const,
      payload: { cancelledBy: "user" as const, unexpectedField: "nope" },
    };
    expect(runCancelledEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects a negative event sequence number", () => {
    const event = { ...envelope, sequence: -1, type: "run.started" as const, payload: {} };
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects an unknown event type", () => {
    const event = { ...envelope, type: "run.paused", payload: {} };
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects a payload that does not match its declared event type", () => {
    const event = {
      ...envelope,
      type: "run.started" as const,
      payload: { toolCallId: "call-1", toolName: "read_file" },
    };
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects an invalid file.changed operation", () => {
    const event = {
      ...envelope,
      type: "file.changed" as const,
      payload: { path: "src/index.ts", operation: "renamed" },
    };
    expect(fileChangedEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects an invalid approval.required risk level", () => {
    const event = {
      ...envelope,
      type: "approval.required" as const,
      payload: { reason: "Push to protected branch", riskLevel: "extreme" },
    };
    expect(approvalRequiredEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects an event with unexpected fields at the envelope boundary", () => {
    const event = {
      ...envelope,
      type: "run.started" as const,
      payload: {},
      unexpectedField: "should not be accepted",
    };
    expect(normalizedAgentEventSchema.safeParse(event).success).toBe(false);
  });

  it("throws a ProtocolValidationError via parseNormalizedAgentEvent for invalid input", () => {
    expect(() => parseNormalizedAgentEvent({ ...envelope, type: "not.a.real.event" })).toThrow();
  });
});
