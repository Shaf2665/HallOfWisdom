import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { CommunicationAuthor } from "@hall-of-wisdom/protocol";
import { createMessageRequestSchema } from "../schemas/create-message-request.js";
import { InvalidMessageError, InvalidRequestError } from "../errors/app-error.js";
import type { BoardStorePort } from "../boards/board-store-port.js";
import type { MessageStorePort } from "../boards/message-store-port.js";
import type { MessageBus } from "../boards/message-bus.js";
import type { AttachmentStorePort } from "../boards/attachment-store-port.js";
import type { AttachmentBlobStore } from "../boards/attachment-blob-store.js";

export interface BoardRoutesDeps {
  readonly boardStore: BoardStorePort;
  readonly messageStore: MessageStorePort;
  readonly messageBus: MessageBus;
  readonly attachmentStore: AttachmentStorePort;
  readonly attachmentBlobStore: AttachmentBlobStore;
  /** See `ServerLimits.pendingAttachmentTtlMs`'s doc comment. */
  readonly pendingAttachmentTtlMs: number;
}

/**
 * Phase 8 supports exactly one author: the local human operator. Always
 * constructed here, server-side — never read from a request body (see
 * `createMessageRequestSchema`, whose shape has no `author` field at all).
 */
const LOCAL_OPERATOR_AUTHOR: CommunicationAuthor = {
  kind: "human",
  displayName: "Local Operator",
};

interface BoardIdParams {
  readonly boardId: string;
}

interface TaskIdParams {
  readonly taskId: string;
}

interface MessagesQuery {
  readonly afterSequence?: string;
}

/**
 * Opportunistic, lazy cleanup — no background timer. Mirrors
 * `routes/board-attachments.ts`'s identical helper (kept as a separate,
 * tiny copy rather than a shared import, the same "domains stay apart"
 * discipline `MessageBus`/`EventBus` already follow) — called here too so a
 * message-creation attempt that never happens (abandoned upload) or fails
 * partway is covered by the same mechanism as an abandoned upload. See
 * `docs/architecture/0020-communication-board-attachments.md`.
 */
function sweepExpiredPendingAttachments(deps: BoardRoutesDeps): void {
  const cutoffIso = new Date(Date.now() - deps.pendingAttachmentTtlMs).toISOString();
  const sweptAttachmentIds = deps.attachmentStore.sweepExpiredPending(cutoffIso);
  for (const attachmentId of sweptAttachmentIds) {
    deps.attachmentBlobStore.remove(attachmentId);
  }
}

function parseAfterSequenceQuery(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidRequestError("afterSequence must be a non-negative integer.");
  }
  return parsed;
}

export function registerBoardRoutes(app: FastifyInstance, deps: BoardRoutesDeps): void {
  app.get("/api/v1/boards", () => {
    return { boards: deps.boardStore.list() };
  });

  app.get<{ Params: BoardIdParams }>("/api/v1/boards/:boardId", (request) => {
    return deps.boardStore.get(request.params.boardId);
  });

  /**
   * Ensures a discussion board exists for `taskId` — idempotent by
   * construction (see `BoardStore.ensureTaskBoard()`'s doc comment), never
   * touches the task's status, run, or any execution state. `created`
   * decides `201` vs `200`; the response body shape is identical either
   * way so a client never needs to branch on status code to read the
   * board.
   */
  app.post<{ Params: TaskIdParams }>("/api/v1/tasks/:taskId/board", async (request, reply) => {
    const now = new Date().toISOString();
    const { board, created } = deps.boardStore.ensureTaskBoard(request.params.taskId, now);
    if (created) {
      deps.messageStore.registerBoard(board.boardId);
    }
    await reply.status(created ? 201 : 200).send({
      board,
      messagesPath: `/api/v1/boards/${board.boardId}/messages`,
      livePath: `/api/v1/boards/${board.boardId}/messages/live`,
    });
  });

  app.get<{ Params: BoardIdParams; Querystring: MessagesQuery }>(
    "/api/v1/boards/:boardId/messages",
    (request) => {
      const afterSequence = parseAfterSequenceQuery(request.query.afterSequence);
      return { messages: deps.messageStore.list(request.params.boardId, afterSequence) };
    },
  );

  /**
   * The only endpoint that ever creates a message. Order matters: the
   * message is fully validated and stored (`messageStore.append`, which is
   * synchronous and atomic) *before* the board's `messageCount`/`updatedAt`
   * are updated, which in turn happens *before* `messageBus.publish()` —
   * so a subscriber can never observe a message that the store failed to
   * durably record, and `GET .../messages` immediately after this request
   * settles always reflects it.
   */
  app.post<{ Params: BoardIdParams }>(
    "/api/v1/boards/:boardId/messages",
    async (request, reply) => {
      const parsed = createMessageRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        const details = parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        }));
        throw new InvalidMessageError("Message body failed validation.", details);
      }

      const boardId = request.params.boardId;
      const now = new Date().toISOString();

      sweepExpiredPendingAttachments(deps);

      // Resolved BEFORE messageStore.append() — an unknown/wrong-board/
      // already-linked attachmentId throws here, so nothing is ever stored
      // for a request naming a bad attachment. The client sends only ids;
      // canonical filename/mime/size always come from Hall Core's own
      // attachment store, never from the request body.
      const attachmentIds = parsed.data.attachmentIds ?? [];
      const attachments =
        attachmentIds.length > 0 ? deps.attachmentStore.resolvePending(boardId, attachmentIds) : [];

      const message = deps.messageStore.append(boardId, {
        messageId: randomUUID(),
        boardId,
        author: LOCAL_OPERATOR_AUTHOR,
        text: parsed.data.text,
        ...(attachments.length > 0 ? { attachments } : {}),
        createdAt: now,
      });
      if (attachmentIds.length > 0) {
        deps.attachmentStore.link(boardId, attachmentIds, message.messageId);
      }
      deps.boardStore.recordMessageAppended(boardId, message.sequence + 1, now);
      deps.messageBus.publish(boardId, message);

      await reply.status(201).send(message);
    },
  );
}
