"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import {
  isTerminalEvent,
  parseAndClassifyIncomingEvent,
  type EventIdentity,
} from "../lib/task-events";
import type { ConnectionState } from "./use-task-events";

export type { ConnectionState };

export interface UseComparisonCandidateEventsOptions {
  /** Called exactly once, the first time a terminal event is accepted for this candidate. */
  readonly onTerminalEvent?: (event: NormalizedAgentEvent) => void;
}

export interface UseComparisonCandidateEventsResult {
  readonly connectionState: ConnectionState;
  readonly events: readonly NormalizedAgentEvent[];
  /** -1 if no event has been accepted yet. */
  readonly lastContiguousSequence: number;
  /** A short, safe, user-displayable description of the most recent stream problem, or null. */
  readonly lastError: string | null;
  readonly reconnectAttempt: number;
  readonly terminalEventReceived: boolean;
  /** Resets the retry budget and reconnects immediately, bypassing backoff. */
  readonly reconnect: () => void;
}

/**
 * Deliberately no jitter, same fixed schedule as `useTaskEvents` — fully
 * deterministic under fake timers.
 */
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];

const CLOSE_CODE_NORMAL = 1000;
const CLOSE_CODE_INVALID_QUERY = 4400;
const CLOSE_CODE_UNKNOWN_CANDIDATE = 4404;
const CLOSE_CODE_SUBSCRIBER_LIMIT = 4503;
const CLOSE_CODE_CLIENT_TOO_SLOW = 4504;
const CLOSE_CODE_UNSUPPORTED_DATA = 1003;
const CLOSE_CODE_ORIGIN_NOT_ALLOWED = 4403;
const CLOSE_CODE_ABNORMAL = 1006;

/** Same non-retryable bucket reasoning as `useTaskEvents` — see that hook's doc comment. */
const NON_RETRYABLE_CLOSE_CODES = new Set([
  CLOSE_CODE_INVALID_QUERY,
  CLOSE_CODE_UNKNOWN_CANDIDATE,
  CLOSE_CODE_UNSUPPORTED_DATA,
  CLOSE_CODE_ORIGIN_NOT_ALLOWED,
]);

function buildEventsUrl(
  wsBaseUrl: string,
  comparisonId: string,
  candidateId: string,
  afterSequence: number,
): string {
  const path = `${wsBaseUrl}/api/v1/comparisons/${encodeURIComponent(comparisonId)}/candidates/${encodeURIComponent(candidateId)}/events`;
  return afterSequence >= 0 ? `${path}?afterSequence=${String(afterSequence)}` : path;
}

/**
 * Streams one comparison candidate's normalized events over WebSocket, with
 * safe reconnection — mirrors `hooks/use-task-events.ts` exactly (same
 * reconnect/backoff schedule, same close-code vocabulary, same
 * duplicate/gap/conflict/identity classification via
 * `lib/task-events.ts`'s shared helpers), just keyed by
 * `(comparisonId, candidateId)` and pointed at
 * `GET /api/v1/comparisons/:comparisonId/candidates/:candidateId/events`
 * instead of the task-events route. The server's own event envelope uses
 * the candidate's `candidateId` as its `taskId` field (see
 * `ComparisonOrchestrator`), so the same `EventIdentity` shape applies
 * unchanged.
 */
export function useComparisonCandidateEvents(
  comparisonId: string | null,
  candidateId: string | null,
  wsBaseUrl: string,
  options: UseComparisonCandidateEventsOptions = {},
): UseComparisonCandidateEventsResult {
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [events, setEvents] = useState<readonly NormalizedAgentEvent[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [terminalEventReceived, setTerminalEventReceived] = useState(false);

  const eventsRef = useRef<NormalizedAgentEvent[]>([]);
  const identityRef = useRef<EventIdentity>({ taskId: "", runId: null, agentId: null });
  const socketRef = useRef<WebSocket | null>(null);
  const generationRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const terminalNotifiedRef = useRef(false);
  const onTerminalEventRef = useRef(options.onTerminalEvent);
  useEffect(() => {
    onTerminalEventRef.current = options.onTerminalEvent;
  });

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
      setReconnectAttempt(reconnectAttemptRef.current);
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
      if (comparisonId === null || candidateId === null) return;
      closeCurrentSocket();
      const generation = generationRef.current;
      setConnectionState("connecting");

      const socket = new WebSocket(
        buildEventsUrl(wsBaseUrl, comparisonId, candidateId, afterSequence),
      );
      socketRef.current = socket;

      socket.onopen = () => {
        if (generationRef.current !== generation) return;
        setConnectionState("connected");
      };

      socket.onmessage = (messageEvent: MessageEvent) => {
        if (generationRef.current !== generation) return;
        if (typeof messageEvent.data !== "string") {
          setLastError("Received a non-text message from the event stream.");
          return;
        }

        const outcome = parseAndClassifyIncomingEvent(
          messageEvent.data,
          eventsRef.current,
          identityRef.current,
        );

        switch (outcome.kind) {
          case "accepted": {
            if (identityRef.current.runId === null) {
              identityRef.current = {
                taskId: identityRef.current.taskId,
                runId: outcome.event.runId,
                agentId: outcome.event.agentId,
              };
            }
            const next = [...eventsRef.current, outcome.event];
            eventsRef.current = next;
            setEvents(next);
            reconnectAttemptRef.current = 0;
            setReconnectAttempt(0);
            if (isTerminalEvent(outcome.event)) {
              setTerminalEventReceived(true);
              if (!terminalNotifiedRef.current) {
                terminalNotifiedRef.current = true;
                onTerminalEventRef.current?.(outcome.event);
              }
            }
            break;
          }
          case "duplicate":
            break;
          case "gap":
            setLastError("The event stream skipped ahead; reconnecting to catch up.");
            closeCurrentSocket();
            scheduleReconnect(eventsRef.current.length - 1);
            break;
          case "conflict":
            setLastError("The event stream reported conflicting data for this candidate.");
            closeCurrentSocket();
            setConnectionState("error");
            break;
          case "identity-mismatch":
            setLastError("The event stream reported an event for a different candidate or run.");
            closeCurrentSocket();
            setConnectionState("error");
            break;
          case "invalid":
            setLastError("The event stream sent a message that could not be understood.");
            closeCurrentSocket();
            setConnectionState("error");
            break;
        }
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

        if (terminalNotifiedRef.current && closeEvent.code === CLOSE_CODE_NORMAL) {
          setConnectionState("completed");
          return;
        }
        if (closeEvent.code === CLOSE_CODE_NORMAL) {
          scheduleReconnect(eventsRef.current.length - 1);
          return;
        }
        if (NON_RETRYABLE_CLOSE_CODES.has(closeEvent.code)) {
          setLastError(describeCloseCode(closeEvent.code));
          setConnectionState("error");
          return;
        }
        if (
          closeEvent.code === CLOSE_CODE_SUBSCRIBER_LIMIT ||
          closeEvent.code === CLOSE_CODE_CLIENT_TOO_SLOW ||
          closeEvent.code === CLOSE_CODE_ABNORMAL
        ) {
          setLastError(describeCloseCode(closeEvent.code));
          scheduleReconnect(eventsRef.current.length - 1);
          return;
        }
        setLastError(describeCloseCode(closeEvent.code));
        scheduleReconnect(eventsRef.current.length - 1);
      };
    },
    [comparisonId, candidateId, wsBaseUrl, closeCurrentSocket, scheduleReconnect],
  );
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const reconnect = useCallback(() => {
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    setLastError(null);
    connect(eventsRef.current.length - 1);
  }, [clearReconnectTimer, connect]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    generationRef.current += 1;
    clearReconnectTimer();
    closeCurrentSocket();
    eventsRef.current = [];
    setEvents([]);
    setLastError(null);
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    setTerminalEventReceived(false);
    terminalNotifiedRef.current = false;
    identityRef.current = { taskId: candidateId ?? "", runId: null, agentId: null };

    if (comparisonId === null || candidateId === null) {
      setConnectionState("idle");
      return;
    }

    connect(-1);

    return () => {
      generationRef.current += 1;
      clearReconnectTimer();
      closeCurrentSocket();
    };
  }, [comparisonId, candidateId, wsBaseUrl, connect, clearReconnectTimer, closeCurrentSocket]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return {
    connectionState,
    events,
    lastContiguousSequence: events.length - 1,
    lastError,
    reconnectAttempt,
    terminalEventReceived,
    reconnect,
  };
}

function describeCloseCode(code: number): string {
  switch (code) {
    case CLOSE_CODE_SUBSCRIBER_LIMIT:
      return "Too many viewers are already watching this candidate; retrying shortly.";
    case CLOSE_CODE_CLIENT_TOO_SLOW:
      return "Live updates fell behind; reconnecting to catch up.";
    case CLOSE_CODE_ABNORMAL:
      return "The connection to Hall Core was lost; reconnecting.";
    case CLOSE_CODE_INVALID_QUERY:
      return "The event stream request was invalid.";
    case CLOSE_CODE_UNKNOWN_CANDIDATE:
      return "This candidate no longer exists.";
    case CLOSE_CODE_UNSUPPORTED_DATA:
      return "The event stream connection was closed by the server.";
    case CLOSE_CODE_ORIGIN_NOT_ALLOWED:
      return "Hall Core did not allow this page to connect.";
    default:
      return "Live updates disconnected; reconnecting.";
  }
}
