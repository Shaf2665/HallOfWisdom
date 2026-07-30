import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  communicationBoardSchema,
  communicationMessageSchema,
  parseCommunicationBoard,
  parseCommunicationMessage,
} from "./communication.js";
import { ProtocolValidationError } from "./errors.js";

const validGeneralBoard = {
  boardId: "hall.general",
  kind: "general" as const,
  title: "General",
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
  messageCount: 0,
};

const validTaskBoard = {
  boardId: "task:task-1",
  kind: "task" as const,
  title: "Discussion: Add login page",
  taskId: "task-1",
  projectId: "project-1",
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
  messageCount: 0,
};

const validMessage = {
  messageId: "msg-1",
  boardId: "hall.general",
  sequence: 0,
  author: { kind: "human" as const, displayName: "Local Operator" },
  text: "Hello there.",
  createdAt: "2026-07-15T12:00:00.000Z",
};

describe("communicationBoardSchema", () => {
  it("accepts a valid General board", () => {
    expect(parseCommunicationBoard(validGeneralBoard)).toEqual(validGeneralBoard);
  });

  it("accepts a valid task board", () => {
    expect(parseCommunicationBoard(validTaskBoard)).toEqual(validTaskBoard);
  });

  it("rejects a task board without taskId", () => {
    const { taskId: _taskId, ...withoutTaskId } = validTaskBoard;
    const result = communicationBoardSchema.safeParse(withoutTaskId);
    expect(result.success).toBe(false);
  });

  it("rejects a General board that carries a taskId", () => {
    const result = communicationBoardSchema.safeParse({ ...validGeneralBoard, taskId: "task-1" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const result = communicationBoardSchema.safeParse({ ...validGeneralBoard, extra: "nope" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown board kind", () => {
    const result = communicationBoardSchema.safeParse({ ...validGeneralBoard, kind: "custom" });
    expect(result.success).toBe(false);
  });

  it("rejects a negative messageCount", () => {
    const result = communicationBoardSchema.safeParse({ ...validGeneralBoard, messageCount: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer messageCount", () => {
    const result = communicationBoardSchema.safeParse({ ...validGeneralBoard, messageCount: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects a blank title", () => {
    const result = communicationBoardSchema.safeParse({ ...validGeneralBoard, title: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid createdAt timestamp", () => {
    const result = communicationBoardSchema.safeParse({
      ...validGeneralBoard,
      createdAt: "not-a-timestamp",
    });
    expect(result.success).toBe(false);
  });

  it("throws ProtocolValidationError via parseCommunicationBoard", () => {
    expect.assertions(1);
    try {
      parseCommunicationBoard({ ...validGeneralBoard, kind: "bogus" });
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolValidationError);
    }
  });
});

describe("communicationMessageSchema", () => {
  it("accepts a valid message", () => {
    expect(parseCommunicationMessage(validMessage)).toEqual(validMessage);
  });

  it("preserves internal line breaks", () => {
    const withNewlines = { ...validMessage, text: "line one\nline two\nline three" };
    expect(parseCommunicationMessage(withNewlines).text).toBe("line one\nline two\nline three");
  });

  it("rejects a blank message", () => {
    const result = communicationMessageSchema.safeParse({ ...validMessage, text: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string message", () => {
    const result = communicationMessageSchema.safeParse({ ...validMessage, text: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized message", () => {
    const result = communicationMessageSchema.safeParse({
      ...validMessage,
      text: "x".repeat(4001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a message at exactly the maximum length", () => {
    const result = communicationMessageSchema.safeParse({
      ...validMessage,
      text: "x".repeat(4000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a NUL character in the message text", () => {
    const result = communicationMessageSchema.safeParse({
      ...validMessage,
      text: `hello${String.fromCharCode(0)}world`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative sequence", () => {
    const result = communicationMessageSchema.safeParse({ ...validMessage, sequence: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer sequence", () => {
    const result = communicationMessageSchema.safeParse({ ...validMessage, sequence: 1.5 });
    expect(result.success).toBe(false);
  });

  it("accepts sequence zero", () => {
    const result = communicationMessageSchema.safeParse({ ...validMessage, sequence: 0 });
    expect(result.success).toBe(true);
  });

  it("rejects an author kind other than human or system", () => {
    const result = communicationMessageSchema.safeParse({
      ...validMessage,
      author: { kind: "agent", displayName: "Some Agent" },
    });
    expect(result.success).toBe(false);
  });

  // Phase 14 — the CEO Agent posts bounded audit summaries as a
  // "system"-authored message, never "human".
  it("accepts a system-authored message", () => {
    const result = communicationMessageSchema.safeParse({
      ...validMessage,
      author: { kind: "system", displayName: "CEO Agent" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a system author with an unknown field", () => {
    const result = communicationMessageSchema.safeParse({
      ...validMessage,
      author: { kind: "system", displayName: "CEO Agent", raw: "extra" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const result = communicationMessageSchema.safeParse({ ...validMessage, extra: "nope" });
    expect(result.success).toBe(false);
  });

  it("throws ProtocolValidationError with issue details via parseCommunicationMessage", () => {
    expect.assertions(2);
    try {
      parseCommunicationMessage({ ...validMessage, sequence: -1 });
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolValidationError);
      const validationError = error as ProtocolValidationError;
      expect(validationError.issues.length).toBeGreaterThan(0);
    }
  });
});

describe("browser-safe package output", () => {
  it("communication.ts source contains no Node-specific imports", () => {
    const sourcePath = fileURLToPath(new URL("./communication.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/from ["']node:/);
    expect(source).not.toMatch(/require\(["']node:/);
  });
});
