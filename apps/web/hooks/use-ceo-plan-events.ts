"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ceoPlanEventSchema, type CeoPlanEvent } from "@hall-of-wisdom/protocol";
import type { ConnectionState } from "./use-task-events";

export type { ConnectionState };

export interface UseCeoPlanEventsResult {
  readonly connectionState: ConnectionState;
  readonly events: readonly CeoPlanEvent[];
  /** -1 if no event has been accepted yet. */
  readonly lastSequence: number;
}

/** Same fixed, deterministic reconnect schedule as `useTaskEvents`/`useComparisonCandidateEvents` — no jitter. */
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];

const CLOSE_CODE_INVALID_QUERY = 4400;
const CLOSE_CODE_UNKNOWN_PLAN = 4404;
const CLOSE_CODE_UNSUPPORTED_DATA = 1003;
const CLOSE_CODE_ORIGIN_NOT_ALLOWED = 4403;

const NON_RETRYABLE_CLOSE_CODES = new Set([
  CLOSE_CODE_INVALID_QUERY,
  CLOSE_CODE_UNKNOWN_PLAN,
  CLOSE_CODE_UNSUPPORTED_DATA,
  CLOSE_CODE_ORIGIN_NOT_ALLOWED,
]);

function buildEventsUrl(wsBaseUrl: string, planId: string, afterSequence: number): string {
  const path = `${wsBaseUrl}/api/v1/ceo-plans/${encodeURIComponent(planId)}/events/live`;
  return afterSequence >= 0 ? `${path}?afterSequence=${String(afterSequence)}` : path;
}

/**
 * Streams one CEO plan's bounded audit event stream over WebSocket, with
 * safe reconnection — a smaller sibling of `useTaskEvents`/
 * `useComparisonCandidateEvents`: `CeoPlanEvent` has no `runId`/`agentId`
 * identity to track and no gap/conflict classification (the server's
 * sequence is already monotonic and duplicate-free per
 * `routes/ceo-plans.ts`'s `handleCeoPlanEventsConnection`), so this hook
 * only needs plain sequence-based dedup: accept strictly increasing
 * sequences, ignore anything at or below what's already been seen. This
 * stream is a bounded audit trail, not the source of progress truth —
 * callers still re-fetch `getCeoPlan()` for authoritative plan/progress
 * state; see `components/ceo/ceo-plan-detail.tsx`.
 */
export function useCeoPlanEvents(planId: string | null, wsBaseUrl: string): UseCeoPlanEventsResult {
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [events, setEvents] = useState<readonly CeoPlanEvent[]>([]);

  const eventsRef = useRef<CeoPlanEvent[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const generationRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const closeCurrentSocket = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socketRef.current = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }, []);

  const connectRef = useRef<(afterSequence: number) => void>(() => undefined);

  const scheduleReconnect = useCallback(
    (afterSequence: number) => {
      const current = reconnectAttemptRef.current;
      if (current >= RECONNECT_DELAYS_MS.length) {
        setConnectionState("disconnected");
        return;
      }
      setConnectionState("reconnecting");
      const delay =
        RECONNECT_DELAYS_MS[current] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
      reconnectAttemptRef.current = current + 1;
      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connectRef.current(afterSequence);
      }, delay);
    },
    [clearReconnectTimer],
  );

  const connect = useCallback(
    (afterSequence: number) => {
      if (planId === null) return;
      closeCurrentSocket();
      const generation = generationRef.current;
      setConnectionState("connecting");

      const socket = new WebSocket(buildEventsUrl(wsBaseUrl, planId, afterSequence));
      socketRef.current = socket;

      socket.onopen = () => {
        if (generationRef.current !== generation) return;
        setConnectionState("connected");
      };

      socket.onmessage = (messageEvent: MessageEvent) => {
        if (generationRef.current !== generation) return;
        if (typeof messageEvent.data !== "string") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(messageEvent.data);
        } catch {
          return;
        }
        const result = ceoPlanEventSchema.safeParse(parsed);
        if (!result.success) return;
        const event = result.data;
        const lastSeen = eventsRef.current[eventsRef.current.length - 1]?.sequence ?? -1;
        if (event.sequence <= lastSeen) return;
        const next = [...eventsRef.current, event];
        eventsRef.current = next;
        setEvents(next);
        reconnectAttemptRef.current = 0;
      };

      socket.onerror = () => {
        if (generationRef.current !== generation) return;
      };

      socket.onclose = (closeEvent: CloseEvent) => {
        if (generationRef.current !== generation) return;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socketRef.current = null;

        const resumeFrom = eventsRef.current[eventsRef.current.length - 1]?.sequence ?? -1;
        if (NON_RETRYABLE_CLOSE_CODES.has(closeEvent.code)) {
          setConnectionState("error");
          return;
        }
        scheduleReconnect(resumeFrom);
      };
    },
    [planId, wsBaseUrl, closeCurrentSocket, scheduleReconnect],
  );
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    generationRef.current += 1;
    clearReconnectTimer();
    closeCurrentSocket();
    eventsRef.current = [];
    setEvents([]);
    reconnectAttemptRef.current = 0;

    if (planId === null) {
      setConnectionState("idle");
      return;
    }

    connect(-1);

    return () => {
      generationRef.current += 1;
      clearReconnectTimer();
      closeCurrentSocket();
    };
  }, [planId, wsBaseUrl, connect, clearReconnectTimer, closeCurrentSocket]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return {
    connectionState,
    events,
    lastSequence: events[events.length - 1]?.sequence ?? -1,
  };
}
