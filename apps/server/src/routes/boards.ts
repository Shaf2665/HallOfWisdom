import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { CommunicationAuthor } from "@hall-of-wisdom/protocol";
import { createMessageRequestSchema } from "../schemas/create-message-request.js";
import { InvalidMessageError, InvalidRequestError } from "../errors/app-error.js";
import type { BoardStore } from "../boards/board-store.js";
import type { MessageStore } from "../boards/message-store.js";
import type { MessageBus } from "../boards/message-bus.js";

export interface BoardRoutesDeps {
  readonly boardStore: BoardStore;
  readonly messageStore: MessageStore;
  readonly messageBus: MessageBus;
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
      const message = deps.messageStore.append(boardId, {
        messageId: randomUUID(),
        boardId,
        author: LOCAL_OPERATOR_AUTHOR,
        text: parsed.data.text,
        createdAt: now,
      });
      deps.boardStore.recordMessageAppended(boardId, message.sequence + 1, now);
      deps.messageBus.publish(boardId, message);

      await reply.status(201).send(message);
    },
  );
}
