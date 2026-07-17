import { describe, expect, it } from "vitest";
import { hallTaskSchema } from "./task.js";
import { structuredFailureSchema, safeDetailsSchema } from "./errors.js";
import { communicationBoardSchema, communicationMessageSchema } from "./communication.js";

describe("prototype pollution resistance", () => {
  it("rejects a JSON-parsed object carrying an own __proto__ key as an unexpected field", () => {
    const maliciousTask = JSON.parse(
      '{"taskId":"task-1","projectId":"project-1","title":"t","description":"d","priority":"low","status":"backlog","dependencyTaskIds":[],"createdAt":"2026-07-15T12:00:00.000Z","updatedAt":"2026-07-15T12:00:00.000Z","__proto__":{"polluted":true}}',
    ) as unknown;

    const result = hallTaskSchema.safeParse(maliciousTask);

    expect(result.success).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects a JSON-parsed communication board carrying an own __proto__ key", () => {
    const maliciousBoard = JSON.parse(
      '{"boardId":"hall.general","kind":"general","title":"General","createdAt":"2026-07-15T12:00:00.000Z","updatedAt":"2026-07-15T12:00:00.000Z","messageCount":0,"__proto__":{"polluted":true}}',
    ) as unknown;

    const result = communicationBoardSchema.safeParse(maliciousBoard);

    expect(result.success).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects a JSON-parsed communication message carrying an own __proto__ key", () => {
    const maliciousMessage = JSON.parse(
      '{"messageId":"msg-1","boardId":"hall.general","sequence":0,"author":{"kind":"human","displayName":"Local Operator"},"text":"hi","createdAt":"2026-07-15T12:00:00.000Z","__proto__":{"polluted":true}}',
    ) as unknown;

    const result = communicationMessageSchema.safeParse(maliciousMessage);

    expect(result.success).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("bounded input sizes", () => {
  it("rejects an excessively large failure message", () => {
    const result = structuredFailureSchema.safeParse({
      code: "SOME_ERROR",
      message: "x".repeat(5000),
    });
    expect(result.success).toBe(false);
  });

  it("rejects failure details containing a nested object instead of a flat primitive", () => {
    const result = structuredFailureSchema.safeParse({
      code: "SOME_ERROR",
      message: "A failure occurred.",
      details: { nested: { shouldNotBeAllowed: true } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a details object with too many keys", () => {
    const details = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`key-${String(index)}`, "value"]),
    );
    expect(safeDetailsSchema.safeParse(details).success).toBe(false);
  });

  it("rejects a details value that exceeds the per-string length bound", () => {
    const result = safeDetailsSchema.safeParse({ output: "x".repeat(5000) });
    expect(result.success).toBe(false);
  });

  it("accepts safe, bounded details", () => {
    const result = safeDetailsSchema.safeParse({
      adapterId: "claude-code",
      exitCode: 1,
      timedOut: false,
    });
    expect(result.success).toBe(true);
  });
});
