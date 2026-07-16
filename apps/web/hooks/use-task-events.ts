"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import {
  isTerminalEvent,
  parseAndClassifyIncomingEvent,
  type EventIdentity,
} from "../lib/task-events";

export type ConnectionState =
  "idle" | "connecting" | "connected" | "reconnecting" | "completed" | "disconnected" | "error";

export interface UseTaskEventsOptions {
  /** Called exactly once, the first time a terminal event is accepted for this task. */
  readonly onTerminalEvent?: (event: NormalizedAgentEvent) => void;
}

export interface UseTaskEventsResult {
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
 * Deliberately no jitter: a fixed schedule is fully deterministic under
 * fake timers, which is what every reconnect test in this module relies
 * on. Capped at 5 attempts (4000ms max delay) before requiring a manual
 * reconnect.
 */
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];

const CLOSE_CODE_NORMAL = 1000;
const CLOSE_CODE_INVALID_QUERY = 4400;
const CLOSE_CODE_UNKNOWN_TASK = 4404;
const CLOSE_CODE_SUBSCRIBER_LIMIT = 4503;
const CLOSE_CODE_CLIENT_TOO_SLOW = 4504;
const CLOSE_CODE_UNSUPPORTED_DATA = 1003;
const CLOSE_CODE_ORIGIN_NOT_ALLOWED = 4403;
const CLOSE_CODE_ABNORMAL = 1006;

/**
 * Close codes Hall Core (or the browser) can send that must never trigger
 * an automatic reconnect. `4403` (Origin not allowed) belongs here, not in
 * the reconnectable bucket: a rejected Origin is a static condition tied
 * to how this page itself was loaded — retrying the exact same connection
 * from the exact same page can never produce a different outcome.
 */
const NON_RETRYABLE_CLOSE_CODES = new Set([
  CLOSE_CODE_INVALID_QUERY,
  CLOSE_CODE_UNKNOWN_TASK,
  CLOSE_CODE_UNSUPPORTED_DATA,
  CLOSE_CODE_ORIGIN_NOT_ALLOWED,
]);

function buildEventsUrl(wsBaseUrl: string, taskId: string, afterSequence: number): string {
  const path = `${wsBaseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/events`;
  return afterSequence >= 0 ? `${path}?afterSequence=${String(afterSequence)}` : path;
}

/**
 * Streams one task's normalized events over WebSocket, with safe
 * reconnection. See `docs/architecture/0005-minimal-web-interface.md`,
 * "WebSocket replay and reconnect" for the full contract this
 * implements: at-least-once delivery across a reconnect, client-side
 * deduplication by sequence/eventId, and a documented, bounded retry
 * policy keyed off Hall Core's own close codes.
 */
export function useTaskEvents(
  taskId: string | null,
  wsBaseUrl: string,
  options: UseTaskEventsOptions = {},
): UseTaskEventsResult {
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

  /** Closes the current socket (if any), tearing down its handlers first so a late event from it can never fire. */
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

  // Deliberately reads/writes `reconnectAttemptRef` (not the `useState`
  // setter's functional-updater form) to decide whether to schedule
  // another attempt: a React state updater must be a pure function (React
  // may invoke it more than once per update, e.g. under Strict Mode), so
  // side effects like starting a timer or calling `setConnectionState`
  // cannot safely live inside one. `reconnectAttempt` state is still kept
  // in sync right after, purely for rendering.
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
      if (taskId === null) return;
      closeCurrentSocket();
      const generation = generationRef.current;
      setConnectionState("connecting");

      const socket = new WebSocket(buildEventsUrl(wsBaseUrl, taskId, afterSequence));
      socketRef.current = socket;

      socket.onopen = () => {
        if (generationRef.current !== generation) return;
        setConnectionState("connected");
        // Deliberately does NOT reset the retry budget here. The WebSocket
        // handshake (and therefore this `open` event) completes before
        // Hall Core's route handler runs its own checks — a connection can
        // still be closed immediately after opening with a retryable code
        // (4503 subscriber limit, 4504 client too slow). Resetting on
        // `open` would let a server that keeps rejecting the connection
        // reconnect forever at the fastest backoff step, defeating the
        // retry cap. The budget is reset only once real progress is made:
        // see the "accepted" branch in `onmessage` below.
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
            // A successful event delivery is real proof this connection is
            // healthy — ends the current outage, so the next disconnect
            // (whenever it happens) gets a fresh retry budget instead of
            // continuing to count from a previous, already-resolved outage.
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
            setLastError("The event stream reported conflicting data for this task.");
            closeCurrentSocket();
            setConnectionState("error");
            break;
          case "identity-mismatch":
            setLastError("The event stream reported an event for a different task or run.");
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
        // The close handler (always fired after error for a WebSocket)
        // owns the actual state transition/reconnect decision.
      };

      socket.onclose = (closeEvent: CloseEvent) => {
        if (generationRef.current !== generation) return;
        // The server (or the network) initiated this close, not
        // `closeCurrentSocket()` — detach this socket's own handlers
        // explicitly rather than relying on it becoming unreferenced.
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
          // Closed normally but no terminal event was ever accepted —
          // treat like any other unexpected disconnect and try to resume.
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
        // Any other/unrecognized code: default to reconnectable, the
        // safer assumption for a code this client doesn't specifically
        // know to be permanent.
        setLastError(describeCloseCode(closeEvent.code));
        scheduleReconnect(eventsRef.current.length - 1);
      };
    },
    [taskId, wsBaseUrl, closeCurrentSocket, scheduleReconnect],
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

  // This effect resets the hook's exposed state and (re)opens a
  // connection whenever `taskId`/`wsBaseUrl` change — not "state derived
  // from props" in the sense the set-state-in-effect rule is meant to
  // catch, but a hook synchronizing itself with an external resource (a
  // WebSocket subscription) keyed on an external identity. A component
  // can reset its own state on a prop change via a `key`; a hook has no
  // equivalent, so an effect is the correct tool here.
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
    identityRef.current = { taskId: taskId ?? "", runId: null, agentId: null };

    if (taskId === null) {
      setConnectionState("idle");
      return;
    }

    connect(-1);

    return () => {
      // Bumps the generation a second time for this same transition (once
      // above, once here) — harmless: the guard everywhere else is a plain
      // inequality check against whatever the latest value is, not an
      // exact-match on a specific number, so incrementing by 2 instead of
      // 1 changes nothing observable.
      generationRef.current += 1;
      clearReconnectTimer();
      closeCurrentSocket();
    };
    // `connect`'s own dependency array ([taskId, wsBaseUrl, closeCurrentSocket,
    // scheduleReconnect]) only ever changes identity when taskId/wsBaseUrl
    // do (closeCurrentSocket/scheduleReconnect are themselves referentially
    // stable), so including it here is equivalent to depending on
    // [taskId, wsBaseUrl] directly.
  }, [taskId, wsBaseUrl, connect, clearReconnectTimer, closeCurrentSocket]);
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
      return "Too many viewers are already watching this task; retrying shortly.";
    case CLOSE_CODE_CLIENT_TOO_SLOW:
      return "Live updates fell behind; reconnecting to catch up.";
    case CLOSE_CODE_ABNORMAL:
      return "The connection to Hall Core was lost; reconnecting.";
    case CLOSE_CODE_INVALID_QUERY:
      return "The event stream request was invalid.";
    case CLOSE_CODE_UNKNOWN_TASK:
      return "This task no longer exists.";
    case CLOSE_CODE_UNSUPPORTED_DATA:
      return "The event stream connection was closed by the server.";
    case CLOSE_CODE_ORIGIN_NOT_ALLOWED:
      return "Hall Core did not allow this page to connect.";
    default:
      return "Live updates disconnected; reconnecting.";
  }
}
