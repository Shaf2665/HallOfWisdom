import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { isTerminalEventType } from "@hall-of-wisdom/hall-runner";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { SubscriberLimitReachedError, type EventBus } from "../events/event-bus.js";
import type { EventStore } from "../events/event-store.js";
import type { ComparisonStore } from "../comparisons/comparison-store.js";
import { parseWebOrigin } from "../config/web-origin.js";

export interface ComparisonCandidateEventsRouteDeps {
  readonly comparisonStore: ComparisonStore;
  readonly eventStore: EventStore;
  readonly eventBus: EventBus;
  readonly maxBufferedBytes: number;
  readonly allowedOrigin: string;
}

interface ComparisonCandidateEventsParams {
  readonly comparisonId: string;
  readonly candidateId: string;
}

interface ComparisonCandidateEventsQuery {
  readonly afterSequence?: string;
}

export interface ComparisonCandidateEventsSocket {
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: () => void): unknown;
}

export const CLOSE_CODE_UNKNOWN_CANDIDATE = 4404;
export const CLOSE_CODE_INVALID_QUERY = 4400;
export const CLOSE_CODE_SUBSCRIBER_LIMIT = 4503;
export const CLOSE_CODE_NORMAL = 1000;
export const CLOSE_CODE_UNSUPPORTED_DATA = 1003;
export const CLOSE_CODE_ORIGIN_NOT_ALLOWED = 4403;
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
 * Mirrors `handleTaskEventsConnection` (`routes/task-events.ts`) exactly —
 * same Origin-check-first ordering, same `afterSequence` replay-then-live
 * subscribe sequencing (subscribe registered before reading stored
 * history, to avoid a gap), same `bufferedAmount`-based backpressure and
 * close-code vocabulary — just keyed by `candidateId` instead of `taskId`,
 * and validated against `comparisonId` first so a client cannot stream
 * events for a candidate under a comparison it does not belong to.
 */
export function handleComparisonCandidateEventsConnection(
  socket: ComparisonCandidateEventsSocket,
  params: {
    readonly comparisonId: string;
    readonly candidateId: string;
    readonly afterSequenceRaw: string | undefined;
    readonly originRaw: string | undefined;
  },
  deps: ComparisonCandidateEventsRouteDeps,
): void {
  const { comparisonId, candidateId } = params;

  if (!isOriginAllowed(params.originRaw, deps.allowedOrigin)) {
    socket.close(CLOSE_CODE_ORIGIN_NOT_ALLOWED, "origin not allowed");
    return;
  }

  try {
    const comparison = deps.comparisonStore.get(comparisonId);
    const belongs = comparison.candidates.some(
      (candidate) => candidate.candidateId === candidateId,
    );
    if (!belongs) {
      socket.close(CLOSE_CODE_UNKNOWN_CANDIDATE, "unknown candidate");
      return;
    }
  } catch {
    socket.close(CLOSE_CODE_UNKNOWN_CANDIDATE, "unknown comparison");
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
      finished = true;
      unsubscribe?.();
      socket.close(CLOSE_CODE_CLIENT_TOO_SLOW, "client too slow: reconnect with afterSequence");
      return;
    }

    try {
      socket.send(JSON.stringify(event));
    } catch {
      // no-op
    }
    lastDelivered = event.sequence;
    if (isTerminalEventType(event.type)) {
      finished = true;
      unsubscribe?.();
      socket.close(CLOSE_CODE_NORMAL, "terminal event delivered");
    }
  };

  try {
    unsubscribe = deps.eventBus.subscribe(candidateId, send);
  } catch (error) {
    if (error instanceof SubscriberLimitReachedError) {
      socket.close(CLOSE_CODE_SUBSCRIBER_LIMIT, "subscriber limit reached");
      return;
    }
    throw error;
  }

  for (const event of deps.eventStore.list(candidateId, afterSequence)) {
    send(event);
  }

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

export function registerComparisonCandidateEventsRoute(
  app: FastifyInstance,
  deps: ComparisonCandidateEventsRouteDeps,
): void {
  app.get<{ Params: ComparisonCandidateEventsParams; Querystring: ComparisonCandidateEventsQuery }>(
    "/api/v1/comparisons/:comparisonId/candidates/:candidateId/events",
    { websocket: true },
    (socket: WebSocket, request) => {
      handleComparisonCandidateEventsConnection(
        socket,
        {
          comparisonId: request.params.comparisonId,
          candidateId: request.params.candidateId,
          afterSequenceRaw: request.query.afterSequence,
          originRaw: request.headers.origin,
        },
        deps,
      );
    },
  );
}
