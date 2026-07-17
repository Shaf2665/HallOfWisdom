import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { communicationMessageSchema, type CommunicationMessage } from "@hall-of-wisdom/protocol";
import { MessageSubscriberLimitReachedError, type MessageBus } from "../boards/message-bus.js";
import type { MessageStore } from "../boards/message-store.js";
import type { BoardStore } from "../boards/board-store.js";
import { parseWebOrigin } from "../config/web-origin.js";

export interface BoardMessagesRouteDeps {
  readonly boardStore: BoardStore;
  readonly messageStore: MessageStore;
  readonly messageBus: MessageBus;
  /** A client is disconnected (not silently skipped) once its `bufferedAmount` exceeds this many bytes. */
  readonly maxBufferedBytes: number;
  /** The one browser origin allowed to open this connection; a present-but-different Origin header is rejected. */
  readonly allowedOrigin: string;
}

interface BoardMessagesParams {
  readonly boardId: string;
}

interface BoardMessagesQuery {
  readonly afterSequence?: string;
}

/**
 * The minimal shape `handleBoardMessagesConnection` needs from a socket —
 * identical in shape to `TaskEventsSocket`, but kept as a wholly separate
 * type (not reused across modules) so the two domains never blur into one
 * "generic Hall Core socket" abstraction.
 */
export interface BoardMessagesSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: () => void): unknown;
}

export const CLOSE_CODE_UNKNOWN_BOARD = 4404;
export const CLOSE_CODE_INVALID_QUERY = 4400;
export const CLOSE_CODE_SUBSCRIBER_LIMIT = 4503;
export const CLOSE_CODE_NORMAL = 1000;
export const CLOSE_CODE_UNSUPPORTED_DATA = 1003;
/** Same numeric meaning as `task-events.ts`'s `CLOSE_CODE_ORIGIN_NOT_ALLOWED` — see that module's doc comment for the full Origin-validation policy this mirrors exactly. */
export const CLOSE_CODE_ORIGIN_NOT_ALLOWED = 4403;
/** Same numeric meaning as `task-events.ts`'s `CLOSE_CODE_CLIENT_TOO_SLOW`. */
export const CLOSE_CODE_CLIENT_TOO_SLOW = 4504;

function parseAfterSequence(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return Number.NaN;
  return parsed;
}

function isOriginAllowed(originRaw: string | undefined, allowedOrigin: string): boolean {
  if (originRaw === undefined) return true;
  try {
    return parseWebOrigin(originRaw) === allowedOrigin;
  } catch {
    return false;
  }
}

/**
 * Drives one WebSocket connection end to end. Unlike
 * `handleTaskEventsConnection`, a board's message stream has no terminal
 * concept — a discussion never "finishes" — so this connection stays open
 * indefinitely (until the client disconnects, the server shuts down, or a
 * policy violation closes it); there is no self-closing branch here at
 * all.
 *
 * Replay-then-live consistency mirrors `task-events.ts` exactly: the live
 * subscriber is registered *before* stored history is read, and every
 * delivery — replay or live — is gated by one monotonically increasing
 * `lastDelivered` sequence, so whichever path reaches a sequence first
 * delivers it and the other skips it (deduplicating replay/live overlap).
 *
 * Every outgoing frame is re-validated through
 * `communicationMessageSchema` immediately before `send()` — a stricter
 * check than `task-events.ts` performs, deliberately: a communication
 * message originates from arbitrary human-typed HTTP input (not a
 * trusted adapter's normalized event stream), so this is defense-in-depth
 * against ever broadcasting a malformed stored value.
 */
export function handleBoardMessagesConnection(
  socket: BoardMessagesSocket,
  params: {
    readonly boardId: string;
    readonly afterSequenceRaw: string | undefined;
    readonly originRaw: string | undefined;
  },
  deps: BoardMessagesRouteDeps,
): void {
  const { boardId } = params;

  if (!isOriginAllowed(params.originRaw, deps.allowedOrigin)) {
    socket.close(CLOSE_CODE_ORIGIN_NOT_ALLOWED, "origin not allowed");
    return;
  }

  try {
    deps.boardStore.get(boardId);
  } catch {
    socket.close(CLOSE_CODE_UNKNOWN_BOARD, "unknown board");
    return;
  }

  const afterSequence = parseAfterSequence(params.afterSequenceRaw);
  if (Number.isNaN(afterSequence)) {
    socket.close(CLOSE_CODE_INVALID_QUERY, "afterSequence must be a non-negative integer");
    return;
  }

  let lastDelivered = afterSequence ?? -1;
  let finished = false;
  let unsubscribe: (() => void) | undefined;

  const send = (message: CommunicationMessage): void => {
    if (finished || message.sequence <= lastDelivered) return;

    const validated = communicationMessageSchema.safeParse(message);
    if (!validated.success) {
      // A stored/published value that fails its own protocol schema is an
      // internal defect, not something to forward to a browser — skip it
      // rather than crash the connection or broadcast something
      // unvalidated. lastDelivered is deliberately left unchanged so a
      // gap here is visible rather than silently advancing past it.
      return;
    }

    if (socket.bufferedAmount > deps.maxBufferedBytes) {
      finished = true;
      unsubscribe?.();
      socket.close(CLOSE_CODE_CLIENT_TOO_SLOW, "client too slow: reconnect with afterSequence");
      return;
    }

    try {
      socket.send(JSON.stringify(validated.data));
    } catch {
      // A send failure must not crash the server; rely on the socket's
      // own close/error events for cleanup.
    }
    lastDelivered = validated.data.sequence;
  };

  try {
    unsubscribe = deps.messageBus.subscribe(boardId, send);
  } catch (error) {
    if (error instanceof MessageSubscriberLimitReachedError) {
      socket.close(CLOSE_CODE_SUBSCRIBER_LIMIT, "subscriber limit reached");
      return;
    }
    throw error;
  }

  for (const message of deps.messageStore.list(boardId, afterSequence)) {
    send(message);
  }

  // This endpoint is output-only: any client-sent frame closes the
  // connection with a documented policy code rather than being silently
  // accepted as a message-creation command.
  socket.on("message", () => {
    finished = true;
    unsubscribe();
    socket.close(CLOSE_CODE_UNSUPPORTED_DATA, "this endpoint does not accept client messages");
  });

  const cleanup = (): void => {
    finished = true;
    unsubscribe();
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

export function registerBoardMessagesRoute(
  app: FastifyInstance,
  deps: BoardMessagesRouteDeps,
): void {
  app.get<{ Params: BoardMessagesParams; Querystring: BoardMessagesQuery }>(
    "/api/v1/boards/:boardId/messages/live",
    { websocket: true },
    (socket: WebSocket, request) => {
      handleBoardMessagesConnection(
        socket,
        {
          boardId: request.params.boardId,
          afterSequenceRaw: request.query.afterSequence,
          originRaw: request.headers.origin,
        },
        deps,
      );
    },
  );
}
