import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { isTerminalEventType } from "@hall-of-wisdom/hall-runner";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { SubscriberLimitReachedError, type EventBus } from "../events/event-bus.js";
import type { EventStore } from "../events/event-store.js";
import type { TaskStore } from "../tasks/task-store.js";

export interface TaskEventsRouteDeps {
  readonly taskStore: TaskStore;
  readonly eventStore: EventStore;
  readonly eventBus: EventBus;
  /** A client is disconnected (not silently skipped) once its `bufferedAmount` exceeds this many bytes. */
  readonly maxBufferedBytes: number;
}

interface TaskEventsParams {
  readonly taskId: string;
}

interface TaskEventsQuery {
  readonly afterSequence?: string;
}

/**
 * The minimal shape `handleTaskEventsConnection` needs from a socket.
 * `@fastify/websocket`'s real `WebSocket` (re-exported `ws` type) already
 * satisfies this structurally — no adapter is needed at the route
 * boundary. Tests use a small fake object implementing just this
 * interface to drive `bufferedAmount` deterministically, without a real
 * network socket, for the low-level backpressure behavior (see
 * `task-events.test.ts`).
 */
export interface TaskEventsSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: () => void): unknown;
}

export const CLOSE_CODE_UNKNOWN_TASK = 4404;
export const CLOSE_CODE_INVALID_QUERY = 4400;
export const CLOSE_CODE_SUBSCRIBER_LIMIT = 4503;
export const CLOSE_CODE_NORMAL = 1000;
export const CLOSE_CODE_UNSUPPORTED_DATA = 1003;
/**
 * Custom application close code for a client that fell behind: its
 * `bufferedAmount` exceeded `maxBufferedBytes`. In the 4000-4999 private-use
 * range reserved for application-specific WebSocket close codes (RFC 6455
 * §7.4.2), chosen to sit alongside this route's other custom codes
 * (`4404`, `4400`, `4503`). See "WebSocket backpressure policy" in
 * `docs/architecture/0004-hall-core-server.md`.
 */
export const CLOSE_CODE_CLIENT_TOO_SLOW = 4504;

function parseAfterSequence(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return Number.NaN;
  return parsed;
}

/**
 * Drives one WebSocket connection end to end: validates the task and
 * `afterSequence`, subscribes to live events, replays stored history, and
 * delivers events until a terminal event, a slow-client disconnect, an
 * unsupported client message, or the socket itself closing/erroring.
 *
 * Replay-then-live consistency (documented in full in
 * `docs/architecture/0004-hall-core-server.md` "WebSocket replay and live
 * streaming"): the live subscriber is registered *before* stored history
 * is read, and every delivery — whether from replay or from a live
 * publish — is gated by a single, monotonically increasing `lastDelivered`
 * sequence number. Whichever path (replay or live) reaches a given
 * sequence first delivers it; the other skips it. No `setTimeout`/
 * arbitrary delay is used anywhere in this logic.
 *
 * Backpressure policy: once `socket.bufferedAmount` exceeds
 * `deps.maxBufferedBytes`, the event that would have been sent is *not*
 * sent, `lastDelivered` is deliberately left unchanged (so a reconnect
 * with `afterSequence=<lastDelivered>` replays it from the still-authoritative
 * `EventStore`), and the connection is closed immediately with
 * `CLOSE_CODE_CLIENT_TOO_SLOW` — never silently skipped while the
 * connection stays open. This affects only this one subscriber: it never
 * cancels the underlying task, and other subscribers are unaffected
 * (`EventBus.publish` isolates each listener).
 */
export function handleTaskEventsConnection(
  socket: TaskEventsSocket,
  params: { readonly taskId: string; readonly afterSequenceRaw: string | undefined },
  deps: TaskEventsRouteDeps,
): void {
  const { taskId } = params;

  try {
    deps.taskStore.get(taskId);
  } catch {
    socket.close(CLOSE_CODE_UNKNOWN_TASK, "unknown task");
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

  const send = (event: NormalizedAgentEvent): void => {
    if (finished || event.sequence <= lastDelivered) return;

    if (socket.bufferedAmount > deps.maxBufferedBytes) {
      // Deliberately does not update lastDelivered: this event was never
      // delivered, so a reconnect with afterSequence=lastDelivered must
      // still replay it from the EventStore (which remains authoritative
      // regardless of what any one WebSocket client received).
      finished = true;
      unsubscribe?.();
      socket.close(CLOSE_CODE_CLIENT_TOO_SLOW, "client too slow: reconnect with afterSequence");
      return;
    }

    try {
      socket.send(JSON.stringify(event));
    } catch {
      // A send failure must not crash the server; rely on the socket's
      // own close/error events for cleanup.
    }
    lastDelivered = event.sequence;
    if (isTerminalEventType(event.type)) {
      finished = true;
      unsubscribe?.();
      socket.close(CLOSE_CODE_NORMAL, "terminal event delivered");
    }
  };

  try {
    unsubscribe = deps.eventBus.subscribe(taskId, send);
  } catch (error) {
    if (error instanceof SubscriberLimitReachedError) {
      socket.close(CLOSE_CODE_SUBSCRIBER_LIMIT, "subscriber limit reached");
      return;
    }
    throw error;
  }

  for (const event of deps.eventStore.list(taskId, afterSequence)) {
    send(event);
  }

  // This endpoint is output-only: any client-sent frame closes the
  // connection with a documented policy code rather than being silently
  // accepted as a task-control command.
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

export function registerTaskEventsRoute(app: FastifyInstance, deps: TaskEventsRouteDeps): void {
  app.get<{ Params: TaskEventsParams; Querystring: TaskEventsQuery }>(
    "/api/v1/tasks/:taskId/events",
    { websocket: true },
    (socket: WebSocket, request) => {
      handleTaskEventsConnection(
        socket,
        { taskId: request.params.taskId, afterSequenceRaw: request.query.afterSequence },
        deps,
      );
    },
  );
}
