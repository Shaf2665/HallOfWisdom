import { describe, expect, it } from "vitest";
import type { CommunicationMessage } from "@hall-of-wisdom/protocol";
import { parseAndClassifyIncomingMessage } from "./board-messages";

const BOARD_ID = "hall.general";

function makeMessage(
  sequence: number,
  overrides: Partial<CommunicationMessage> = {},
): CommunicationMessage {
  return {
    messageId: `msg-${String(sequence)}`,
    boardId: BOARD_ID,
    sequence,
    author: { kind: "human", displayName: "Local Operator" },
    text: `message ${String(sequence)}`,
    createdAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("parseAndClassifyIncomingMessage", () => {
  it("accepts a valid message at the expected next sequence", () => {
    const outcome = parseAndClassifyIncomingMessage(JSON.stringify(makeMessage(0)), [], BOARD_ID);
    expect(outcome.kind).toBe("accepted");
  });

  it("accepts sequence zero as the first message", () => {
    const outcome = parseAndClassifyIncomingMessage(JSON.stringify(makeMessage(0)), [], BOARD_ID);
    expect(outcome.kind).toBe("accepted");
  });

  it("accepts contiguous messages", () => {
    const first = makeMessage(0);
    const outcome = parseAndClassifyIncomingMessage(
      JSON.stringify(makeMessage(1)),
      [first],
      BOARD_ID,
    );
    expect(outcome.kind).toBe("accepted");
  });

  it("treats an exact duplicate (same sequence, same messageId) as a duplicate", () => {
    const first = makeMessage(0);
    const outcome = parseAndClassifyIncomingMessage(JSON.stringify(first), [first], BOARD_ID);
    expect(outcome.kind).toBe("duplicate");
  });

  it("treats a same-sequence but different-messageId message as a conflict", () => {
    const first = makeMessage(0);
    const conflicting = makeMessage(0, { messageId: "different-id" });
    const outcome = parseAndClassifyIncomingMessage(JSON.stringify(conflicting), [first], BOARD_ID);
    expect(outcome.kind).toBe("conflict");
  });

  it("detects a sequence gap", () => {
    const first = makeMessage(0);
    const outcome = parseAndClassifyIncomingMessage(
      JSON.stringify(makeMessage(5)),
      [first],
      BOARD_ID,
    );
    expect(outcome.kind).toBe("gap");
  });

  it("rejects a message for a different board", () => {
    const outcome = parseAndClassifyIncomingMessage(
      JSON.stringify(makeMessage(0, { boardId: "other-board" })),
      [],
      BOARD_ID,
    );
    expect(outcome.kind).toBe("board-mismatch");
  });

  it("rejects non-JSON input", () => {
    const outcome = parseAndClassifyIncomingMessage("not json", [], BOARD_ID);
    expect(outcome.kind).toBe("invalid");
  });

  it("rejects JSON that does not match the communication message schema", () => {
    const outcome = parseAndClassifyIncomingMessage(
      JSON.stringify({ notAMessage: true }),
      [],
      BOARD_ID,
    );
    expect(outcome.kind).toBe("invalid");
  });

  it("never returns accepted for an invalid message", () => {
    const outcome = parseAndClassifyIncomingMessage("{broken", [], BOARD_ID);
    expect(outcome.kind).not.toBe("accepted");
  });
});
