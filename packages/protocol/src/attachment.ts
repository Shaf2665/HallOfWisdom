import { z } from "zod";
import { nonEmptyIdSchema } from "./ids.js";
import { parseWithSchema } from "./errors.js";

/**
 * `"image"` renders as a thumbnail in `MessageList`; `"file"` renders as a
 * compact filename/size card. Hall Core derives this from the validated
 * MIME type at upload time (see `classifyAttachmentKind`) — it is never
 * trusted from client input.
 */
export const ATTACHMENT_KINDS = ["image", "file"] as const;
export const attachmentKindSchema = z.enum(ATTACHMENT_KINDS);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

/** Per-message cap — mirrors how `MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH` bounds text. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
/** Per-file byte cap, enforced independently by the client (pre-upload) and the server (multipart `limits.fileSize` and a defense-in-depth re-check). */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENT_FILENAME_LENGTH = 200;

/**
 * A conservative allowlist, not an attempt at general file-type support —
 * see the issue's scope constraints (no OCR, no thumbnail service, no virus
 * scanning). Images cover the "vision" UX request; the rest cover the
 * "text/code/document" agent-context request without needing any binary
 * parsing.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/pdf",
  "application/json",
] as const;
export type AllowedAttachmentMimeType = (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

export function isAllowedAttachmentMimeType(mimeType: string): mimeType is AllowedAttachmentMimeType {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Authoritative, server-side classification — never trusts a client-supplied `kind`. */
export function classifyAttachmentKind(mimeType: AllowedAttachmentMimeType): AttachmentKind {
  return mimeType.startsWith("image/") ? "image" : "file";
}

/**
 * True when `value` contains an ASCII control character (code points 0-31,
 * which covers NUL/CR/LF) — built by scanning char codes rather than a
 * literal control-character regex range, so no raw control byte is ever
 * embedded in this source file itself.
 */
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) return true;
  }
  return false;
}

const PATH_SEPARATOR_OR_QUOTE_PATTERN = /["/\\]/;

/**
 * Display metadata only — `filename` is never used to build a filesystem
 * path (attachment content is always addressed by a server-generated
 * `attachmentId`, see `docs/architecture/0020-communication-board-attachments.md`).
 * It does, however, reach an HTTP response header (`Content-Disposition`) on
 * download, so control characters (NUL, CR, LF) and a bare double-quote are
 * rejected as a header-injection guard, alongside path separators as a
 * belt-and-braces reminder that this value must never be treated as a path
 * component even if some future caller forgets the first rule.
 */
export const attachmentFilenameSchema = z
  .string()
  .min(1, "must not be empty")
  .max(MAX_ATTACHMENT_FILENAME_LENGTH, `must not exceed ${String(MAX_ATTACHMENT_FILENAME_LENGTH)} characters`)
  .refine((value) => !containsControlCharacter(value), "must not contain control characters")
  .refine(
    (value) => !PATH_SEPARATOR_OR_QUOTE_PATTERN.test(value),
    'must not contain "/", a backslash, or a double quote',
  );

export const attachmentMimeTypeSchema = z.string().min(1).max(255);

/**
 * Confirmed metadata for one uploaded, message-linked attachment. Deliberately
 * carries no URL, no bytes, and no base64 payload — a confirmed message's
 * `attachments` array is just enough for `MessageList` to render a
 * thumbnail/card and build a `GET /api/v1/boards/:boardId/attachments/:attachmentId`
 * request; the browser never receives raw content over the WebSocket.
 */
export const messageAttachmentSchema = z
  .object({
    attachmentId: nonEmptyIdSchema,
    filename: attachmentFilenameSchema,
    mimeType: attachmentMimeTypeSchema,
    byteSize: z
      .number()
      .int()
      .positive()
      .max(MAX_ATTACHMENT_BYTES, `must not exceed ${String(MAX_ATTACHMENT_BYTES)} bytes`),
    kind: attachmentKindSchema,
  })
  .strict();
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export function parseMessageAttachment(input: unknown): MessageAttachment {
  return parseWithSchema(messageAttachmentSchema, input, "MessageAttachment");
}
