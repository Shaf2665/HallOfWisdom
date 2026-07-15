import { describe, expect, it } from "vitest";
import { agentTaskInputSchema, parseAgentTaskInput } from "./task-input.js";

const validTask = {
  taskId: "task-1",
  projectId: "project-1",
  title: "Add login page",
  description: "Implement the login page per the design spec.",
  priority: "normal" as const,
  status: "assigned" as const,
  dependencyTaskIds: [],
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
};

const validIdentity = {
  agentId: "mock-agent",
  displayName: "Mock Agent",
  adapterId: "hall.mock-agent",
  adapterVersion: "0.1.0",
};

const validInput = {
  hallTask: validTask,
  agentIdentity: validIdentity,
  runId: "run-1",
  workingDirectory: "C:\\Projects\\hall-of-wisdom\\worktrees\\task-1",
};

describe("agentTaskInputSchema", () => {
  it("accepts a minimal valid task input", () => {
    expect(parseAgentTaskInput(validInput)).toEqual(validInput);
  });

  it("accepts a Windows path with spaces as the working directory", () => {
    const input = { ...validInput, workingDirectory: "C:\\Projects\\Hall Of Wisdom\\task-1" };
    expect(agentTaskInputSchema.safeParse(input).success).toBe(true);
  });

  it("accepts bounded, flat metadata", () => {
    const input = { ...validInput, metadata: { retryCount: 1, resumed: false } };
    expect(agentTaskInputSchema.safeParse(input).success).toBe(true);
  });

  it("rejects metadata with a nested object value (unbounded shape)", () => {
    const input = { ...validInput, metadata: { nested: { shouldNotBeAllowed: true } } };
    expect(agentTaskInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects metadata with an excessively long string value", () => {
    const input = { ...validInput, metadata: { blob: "x".repeat(5000) } };
    expect(agentTaskInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects metadata with too many keys", () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`key-${String(index)}`, "value"]),
    );
    const input = { ...validInput, metadata };
    expect(agentTaskInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an empty runId", () => {
    const input = { ...validInput, runId: "" };
    expect(agentTaskInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects unexpected top-level fields, so a credential-like field cannot be smuggled in", () => {
    const input = { ...validInput, providerApiKey: "sk-should-not-be-here" };
    expect(agentTaskInputSchema.safeParse(input).success).toBe(false);
  });
});
