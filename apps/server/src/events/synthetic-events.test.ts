import { describe, expect, it } from "vitest";
import { parseNormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { buildInfrastructureFailureEvent } from "./synthetic-events.js";

describe("buildInfrastructureFailureEvent", () => {
  it("builds a run.failed event carrying the given identity, sequence, and failure code", () => {
    const event = buildInfrastructureFailureEvent({
      runId: "run-1",
      taskId: "task-1",
      agentId: "agent-1",
      sequence: 3,
      code: "EVENT_CAPACITY_REACHED",
      message: "capacity reached",
    });
    expect(event.type).toBe("run.failed");
    expect(event.runId).toBe("run-1");
    expect(event.taskId).toBe("task-1");
    expect(event.agentId).toBe("agent-1");
    expect(event.sequence).toBe(3);
    expect(event.payload.failure).toEqual({
      code: "EVENT_CAPACITY_REACHED",
      message: "capacity reached",
      retryable: false,
    });
  });

  it("passes parseNormalizedAgentEvent", () => {
    const event = buildInfrastructureFailureEvent({
      runId: "run-1",
      taskId: "task-1",
      agentId: "agent-1",
      sequence: 0,
      code: "TASK_EXECUTION_FAILED",
      message: "generic failure",
    });
    expect(() => parseNormalizedAgentEvent(event)).not.toThrow();
  });
});
