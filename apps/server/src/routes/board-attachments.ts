import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentFilenameSchema,
  classifyAttachmentKind,
  isAllowedAttachmentMimeType,
  type MessageAttachment,
} from "@hall-of-wisdom/protocol";
import { AttachmentNotFoundError, BoardNotFoundError, InvalidRequestError } from "../errors/app-error.js";
import type { BoardStorePort } from "../boards/board-store-port.js";
import type { AttachmentStorePort } from "../boards/attachment-store-port.js";
import type { AttachmentBlobStore } from "../boards/attachment-blob-store.js";

export interface BoardAttachmentRoutesDeps {
  readonly boardStore: BoardStorePort;
  readonly attachmentStore: AttachmentStorePort;
  readonly blobStore: AttachmentBlobStore;
  /** See `ServerLimits.pendingAttachmentTtlMs`'s doc comment. */
  readonly pendingAttachmentTtlMs: number;
}

interface BoardIdParams {
  readonly boardId: string;
}

interface AttachmentParams {
  readonly boardId: string;
  readonly attachmentId: string;
}

/** Replaces every character outside printable ASCII with `_` — used only for the `Content-Disposition` `filename=` fallback; the RFC 5987 `filename*=` parameter alongside it carries the real value for clients that support it. */
function asciiFallbackFilename(filename: string): string {
  let result = "";
  for (let index = 0; index < filename.length; index += 1) {
    const code = filename.charCodeAt(index);
    result += code >= 0x20 && code <= 0x7e ? filename.charAt(index) : "_";
  }
  return result;
}

function buildContentDisposition(attachment: MessageAttachment): string {
  const disposition = attachment.kind === "image" ? "inline" : "attachment";
  const fallback = asciiFallbackFilename(attachment.filename);
  const encoded = encodeURIComponent(attachment.filename);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Opportunistic, lazy cleanup — no background timer. Called at the start of
 * every upload and every message-creation attempt (see `routes/boards.ts`),
 * covering both an abandoned upload and a failed message-creation request
 * with the same mechanism. See
 * `docs/architecture/0020-communication-board-attachments.md`.
 */
function sweepExpiredPendingAttachments(deps: BoardAttachmentRoutesDeps): void {
  const cutoffIso = new Date(Date.now() - deps.pendingAttachmentTtlMs).toISOString();
  const sweptAttachmentIds = deps.attachmentStore.sweepExpiredPending(cutoffIso);
  for (const attachmentId of sweptAttachmentIds) {
    deps.blobStore.remove(attachmentId);
  }
}

export function registerBoardAttachmentRoutes(
  app: FastifyInstance,
  deps: BoardAttachmentRoutesDeps,
): void {
  app.post<{ Params: BoardIdParams }>(
    "/api/v1/boards/:boardId/attachments",
    async (request, reply) => {
      const boardId = request.params.boardId;
      if (!deps.boardStore.has(boardId)) throw new BoardNotFoundError(boardId);

      sweepExpiredPendingAttachments(deps);

      // `request.file()`'s single-value promise API resolves with only the
      // FIRST file part and silently leaves a second one alone rather than
      // enforcing the plugin's own `limits.files` — so ">1 file" is
      // detected explicitly here via the async-iterator form instead of
      // relying on that limit to throw.
      const filesIterator = request.files({ throwFileSizeLimit: false });
      const firstResult = await filesIterator.next();
      if (firstResult.done) {
        throw new InvalidRequestError("A file is required.");
      }
      const part = firstResult.value;

      const filenameCheck = attachmentFilenameSchema.safeParse(part.filename);
      if (!filenameCheck.success) {
        throw new InvalidRequestError("Invalid filename.");
      }
      if (!isAllowedAttachmentMimeType(part.mimetype)) {
        throw new InvalidRequestError(`Unsupported file type "${part.mimetype}".`);
      }

      // Buffer fully, THEN validate size, THEN write once — "nothing is
      // ever written to disk on rejection" is true by construction here,
      // never by remembering to unlink a partial file afterward.
      const bytes = await part.toBuffer();
      if (part.file.truncated || bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new InvalidRequestError(
          `File exceeds the maximum size of ${String(MAX_ATTACHMENT_BYTES)} bytes.`,
        );
      }
      if (bytes.length === 0) {
        throw new InvalidRequestError("File must not be empty.");
      }

      // Must be checked AFTER fully draining the first file's stream (busboy
      // requires each part's stream to be consumed before advancing) but
      // BEFORE anything is written to disk.
      const secondResult = await filesIterator.next();
      if (!secondResult.done) {
        throw new InvalidRequestError("Only one file is allowed per upload.");
      }

      const attachmentId = randomUUID();
      const kind = classifyAttachmentKind(part.mimetype);
      const createdAt = new Date().toISOString();

      deps.blobStore.write(attachmentId, bytes);
      deps.attachmentStore.createPending({
        attachmentId,
        boardId,
        filename: filenameCheck.data,
        mimeType: part.mimetype,
        byteSize: bytes.length,
        kind,
        createdAt,
      });

      const attachment: MessageAttachment = {
        attachmentId,
        filename: filenameCheck.data,
        mimeType: part.mimetype,
        byteSize: bytes.length,
        kind,
      };
      await reply.status(201).send(attachment);
    },
  );

  app.get<{ Params: AttachmentParams }>(
    "/api/v1/boards/:boardId/attachments/:attachmentId",
    async (request, reply) => {
      const { boardId, attachmentId } = request.params;
      const attachment = deps.attachmentStore.getLinked(boardId, attachmentId);
      if (!attachment) throw new AttachmentNotFoundError(attachmentId);

      const bytes = deps.blobStore.read(attachmentId);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Disposition", buildContentDisposition(attachment));
      reply.type(attachment.mimeType);
      await reply.send(bytes);
    },
  );
}
