import { describe, expect, it } from "vitest";
import { hallTaskSchema, parseHallTask } from "./task.js";
import { ProtocolValidationError } from "./errors.js";

const validTask = {
  taskId: "task-1",
  projectId: "project-1",
  title: "Add login page",
  description: "Implement the login page per the design spec.",
  priority: "high" as const,
  status: "ready" as const,
  dependencyTaskIds: [],
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
};

describe("hallTaskSchema", () => {
  it("accepts a valid Hall task", () => {
    expect(parseHallTask(validTask)).toEqual(validTask);
  });

  it("rejects an invalid task status", () => {
    const result = hallTaskSchema.safeParse({ ...validTask, status: "in-flight" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty task title", () => {
    const result = hallTaskSchema.safeParse({ ...validTask, title: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a title that is only whitespace", () => {
    const result = hallTaskSchema.safeParse({ ...validTask, title: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid ISO timestamp", () => {
    const result = hallTaskSchema.safeParse({ ...validTask, createdAt: "not-a-timestamp" });
    expect(result.success).toBe(false);
  });

  it("rejects unexpected fields at this strict validation boundary", () => {
    const result = hallTaskSchema.safeParse({ ...validTask, extraField: "nope" });
    expect(result.success).toBe(false);
  });

  it("rejects an excessively large dependency array", () => {
    const tooManyDependencies = Array.from({ length: 201 }, (_, index) => `task-${String(index)}`);
    const result = hallTaskSchema.safeParse({
      ...validTask,
      dependencyTaskIds: tooManyDependencies,
    });
    expect(result.success).toBe(false);
  });

  it("throws ProtocolValidationError with issue details via parseHallTask", () => {
    expect.assertions(2);
    try {
      parseHallTask({ ...validTask, status: "bogus" });
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolValidationError);
      const validationError = error as ProtocolValidationError;
      expect(validationError.issues.length).toBeGreaterThan(0);
    }
  });
});
