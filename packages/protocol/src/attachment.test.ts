import { describe, expect, it } from "vitest";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILENAME_LENGTH,
  attachmentFilenameSchema,
  classifyAttachmentKind,
  isAllowedAttachmentMimeType,
  messageAttachmentSchema,
  parseMessageAttachment,
} from "./attachment.js";
import { ProtocolValidationError } from "./errors.js";

const validAttachment = {
  attachmentId: "attachment-1",
  filename: "diagram.png",
  mimeType: "image/png",
  byteSize: 1024,
  kind: "image" as const,
};

describe("messageAttachmentSchema", () => {
  it("accepts a valid image attachment", () => {
    expect(parseMessageAttachment(validAttachment)).toEqual(validAttachment);
  });

  it("accepts a valid file attachment", () => {
    const fileAttachment = { ...validAttachment, mimeType: "application/pdf", kind: "file" as const };
    expect(parseMessageAttachment(fileAttachment)).toEqual(fileAttachment);
  });

  it("rejects an unknown kind", () => {
    const result = messageAttachmentSchema.safeParse({ ...validAttachment, kind: "video" });
    expect(result.success).toBe(false);
  });

  it("rejects a zero byteSize", () => {
    const result = messageAttachmentSchema.safeParse({ ...validAttachment, byteSize: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative byteSize", () => {
    const result = messageAttachmentSchema.safeParse({ ...validAttachment, byteSize: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer byteSize", () => {
    const result = messageAttachmentSchema.safeParse({ ...validAttachment, byteSize: 1.5 });
    expect(result.success).toBe(false);
  });

  it(`rejects byteSize above ${String(MAX_ATTACHMENT_BYTES)}`, () => {
    const result = messageAttachmentSchema.safeParse({
      ...validAttachment,
      byteSize: MAX_ATTACHMENT_BYTES + 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts byteSize at exactly the maximum", () => {
    const result = messageAttachmentSchema.safeParse({
      ...validAttachment,
      byteSize: MAX_ATTACHMENT_BYTES,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty attachmentId", () => {
    const result = messageAttachmentSchema.safeParse({ ...validAttachment, attachmentId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields, including a client-supplied url (.strict())", () => {
    const result = messageAttachmentSchema.safeParse({
      ...validAttachment,
      url: "https://example.com/file.png",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a JSON-parsed attachment carrying an own __proto__ key", () => {
    const maliciousAttachment: unknown = JSON.parse(
      '{"attachmentId":"a1","filename":"f.png","mimeType":"image/png","byteSize":10,"kind":"image","__proto__":{"polluted":true}}',
    );
    const result = messageAttachmentSchema.safeParse(maliciousAttachment);
    expect(result.success).toBe(false);
    expect((Object.prototype as unknown as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("throws ProtocolValidationError via parseMessageAttachment", () => {
    expect.assertions(1);
    try {
      parseMessageAttachment({ ...validAttachment, byteSize: -1 });
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolValidationError);
    }
  });
});

describe("attachmentFilenameSchema", () => {
  it("accepts an ordinary filename", () => {
    expect(attachmentFilenameSchema.safeParse("report.pdf").success).toBe(true);
  });

  it("rejects an empty filename", () => {
    expect(attachmentFilenameSchema.safeParse("").success).toBe(false);
  });

  it(`rejects a filename over ${String(MAX_ATTACHMENT_FILENAME_LENGTH)} characters`, () => {
    const tooLong = "a".repeat(MAX_ATTACHMENT_FILENAME_LENGTH + 1);
    expect(attachmentFilenameSchema.safeParse(tooLong).success).toBe(false);
  });

  it("accepts a filename at exactly the maximum length", () => {
    const atMax = "a".repeat(MAX_ATTACHMENT_FILENAME_LENGTH);
    expect(attachmentFilenameSchema.safeParse(atMax).success).toBe(true);
  });

  it("rejects a filename containing a NUL character", () => {
    expect(attachmentFilenameSchema.safeParse(`evil${String.fromCharCode(0)}.png`).success).toBe(
      false,
    );
  });

  it("rejects a filename containing a CR/LF (header-injection guard)", () => {
    expect(
      attachmentFilenameSchema.safeParse("evil\r\nX-Injected: true").success,
    ).toBe(false);
  });

  it("rejects a filename containing a forward slash (path-traversal shape)", () => {
    expect(attachmentFilenameSchema.safeParse("../../etc/passwd").success).toBe(false);
  });

  it("rejects a filename containing a backslash", () => {
    expect(attachmentFilenameSchema.safeParse("..\\..\\windows\\win.ini").success).toBe(false);
  });

  it("rejects a filename containing a double quote", () => {
    expect(attachmentFilenameSchema.safeParse('evil".png').success).toBe(false);
  });
});

describe("isAllowedAttachmentMimeType", () => {
  it("accepts every entry in the allowlist", () => {
    for (const mimeType of ALLOWED_ATTACHMENT_MIME_TYPES) {
      expect(isAllowedAttachmentMimeType(mimeType)).toBe(true);
    }
  });

  it("rejects a MIME type not in the allowlist", () => {
    expect(isAllowedAttachmentMimeType("application/x-msdownload")).toBe(false);
  });
});

describe("classifyAttachmentKind", () => {
  it("classifies every image/* MIME type as image", () => {
    expect(classifyAttachmentKind("image/png")).toBe("image");
    expect(classifyAttachmentKind("image/jpeg")).toBe("image");
    expect(classifyAttachmentKind("image/gif")).toBe("image");
    expect(classifyAttachmentKind("image/webp")).toBe("image");
  });

  it("classifies every non-image allowed MIME type as file", () => {
    expect(classifyAttachmentKind("application/pdf")).toBe("file");
    expect(classifyAttachmentKind("text/plain")).toBe("file");
    expect(classifyAttachmentKind("text/markdown")).toBe("file");
    expect(classifyAttachmentKind("text/csv")).toBe("file");
    expect(classifyAttachmentKind("application/json")).toBe("file");
  });
});
