import { describe, expect, it } from "vitest";
import { agentRunSchema, parseAgentRun } from "./agent-run.js";

const baseRun = {
  runId: "run-1",
  taskId: "task-1",
  agentId: "agent-claude-1",
  status: "running" as const,
  createdAt: "2026-07-15T12:00:00.000Z",
  startedAt: "2026-07-15T12:00:01.000Z",
};

describe("agentRunSchema", () => {
  it("accepts a valid agent run without a failure", () => {
    expect(parseAgentRun(baseRun)).toEqual(baseRun);
  });

  it("accepts a run with a structured retryable failure", () => {
    const failedRun = {
      ...baseRun,
      status: "failed" as const,
      completedAt: "2026-07-15T12:05:00.000Z",
      failure: {
        code: "AGENT_TIMEOUT",
        message: "The agent process did not respond within the configured timeout.",
        retryable: true,
      },
    };
    const result = agentRunSchema.safeParse(failedRun);
    expect(result.success).toBe(true);
  });

  it("accepts a run with a structured non-retryable failure and safe details", () => {
    const failedRun = {
      ...baseRun,
      status: "failed" as const,
      completedAt: "2026-07-15T12:05:00.000Z",
      failure: {
        code: "AUTHENTICATION_REQUIRED",
        message: "The adapter reported that authentication is required.",
        retryable: false,
        details: {
          adapterId: "claude-code",
          exitCode: 1,
        },
      },
    };
    const result = agentRunSchema.safeParse(failedRun);
    expect(result.success).toBe(true);
  });

  it("rejects an invalid run status", () => {
    const result = agentRunSchema.safeParse({ ...baseRun, status: "paused" });
    expect(result.success).toBe(false);
  });
});
