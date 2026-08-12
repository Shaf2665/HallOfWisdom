import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@hall-of-wisdom/protocol";
import { createMessageRequestSchema } from "./create-message-request.js";

describe("createMessageRequestSchema", () => {
  it("accepts a plain text message", () => {
    const result = createMessageRequestSchema.safeParse({ text: "hello" });
    expect(result.success).toBe(true);
  });

  it("rejects blank text with no attachmentIds", () => {
    const result = createMessageRequestSchema.safeParse({ text: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string text with no attachmentIds", () => {
    const result = createMessageRequestSchema.safeParse({ text: "" });
    expect(result.success).toBe(false);
  });

  it("accepts blank text when attachmentIds has at least one entry", () => {
    const result = createMessageRequestSchema.safeParse({
      text: "",
      attachmentIds: ["attachment-1"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts text together with attachmentIds", () => {
    const result = createMessageRequestSchema.safeParse({
      text: "see attached",
      attachmentIds: ["attachment-1"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty attachmentIds array combined with blank text", () => {
    const result = createMessageRequestSchema.safeParse({ text: "", attachmentIds: [] });
    expect(result.success).toBe(false);
  });

  it(`rejects more than ${String(MAX_ATTACHMENTS_PER_MESSAGE)} attachmentIds`, () => {
    const attachmentIds = Array.from(
      { length: MAX_ATTACHMENTS_PER_MESSAGE + 1 },
      (_, index) => `attachment-${String(index)}`,
    );
    const result = createMessageRequestSchema.safeParse({ text: "many", attachmentIds });
    expect(result.success).toBe(false);
  });

  it("accepts exactly the maximum number of attachmentIds", () => {
    const attachmentIds = Array.from(
      { length: MAX_ATTACHMENTS_PER_MESSAGE },
      (_, index) => `attachment-${String(index)}`,
    );
    const result = createMessageRequestSchema.safeParse({ text: "many", attachmentIds });
    expect(result.success).toBe(true);
  });

  it("rejects an empty attachmentId string in the array", () => {
    const result = createMessageRequestSchema.safeParse({
      text: "x",
      attachmentIds: [""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown field, including a client-supplied author (.strict())", () => {
    const result = createMessageRequestSchema.safeParse({
      text: "hi",
      author: { kind: "system", displayName: "Fake" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a NUL character in text even when attachments are present", () => {
    const result = createMessageRequestSchema.safeParse({
      text: `hi${String.fromCharCode(0)}there`,
      attachmentIds: ["attachment-1"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects oversized text even when attachments are present", () => {
    const result = createMessageRequestSchema.safeParse({
      text: "x".repeat(4001),
      attachmentIds: ["attachment-1"],
    });
    expect(result.success).toBe(false);
  });
});
