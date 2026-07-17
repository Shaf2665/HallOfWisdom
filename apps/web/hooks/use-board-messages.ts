"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CommunicationMessage } from "@hall-of-wisdom/protocol";
import { parseAndClassifyIncomingMessage } from "../lib/board-messages";

/**
 * Unlike `ConnectionState` in `hooks/use-task-events.ts`, there is no
 * `"completed"` state here: a discussion board never reaches a terminal
 * state the way a task run does, so this stream is never expected to
 * self-close.
 */
export type BoardConnectionState =
  "idle" | "connecting" | "connected" | "reconnecting" | "disconnected" | "error";

export interface UseBoardMessagesResult {
  readonly connectionState: BoardConnectionState;
  readonly messages: readonly CommunicationMessage[];
  /** -1 if no message has been accepted yet. */
  readonly lastContiguousSequence: number;
  readonly lastError: string | null;
  readonly reconnectAttempt: number;
  /** Resets the retry budget and reconnects immediately, bypassing backoff. */
  readonly reconnect: () => void;
}

/** Same fixed, deterministic schedule as `use-task-events.ts` — see that module's doc comment for why no jitter is used. */
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000];

const CLOSE_CODE_INVALID_QUERY = 4400;
const CLOSE_CODE_UNKNOWN_BOARD = 4404;
const CLOSE_CODE_SUBSCRIBER_LIMIT = 4503;
const CLOSE_CODE_CLIENT_TOO_SLOW = 4504;
const CLOSE_CODE_UNSUPPORTED_DATA = 1003;
const CLOSE_CODE_ORIGIN_NOT_ALLOWED = 4403;
const CLOSE_CODE_ABNORMAL = 1006;

/**
 * Close codes that must never trigger an automatic reconnect — the same
 * codes `use-task-events.ts` treats as non-retryable, minus the terminal-
 * event-specific normal-closure handling (a board stream has no such
 * concept, so a `1000` here is treated the same as any other reconnectable
 * disconnect: the default, safer assumption).
 */
const NON_RETRYABLE_CLOSE_CODES = new Set([
  CLOSE_CODE_INVALID_QUERY,
  CLOSE_CODE_UNKNOWN_BOARD,
  CLOSE_CODE_UNSUPPORTED_DATA,
  CLOSE_CODE_ORIGIN_NOT_ALLOWED,
]);

function buildMessagesUrl(wsBaseUrl: string, boardId: string, afterSequence: number): string {
  const path = `${wsBaseUrl}/api/v1/boards/${encodeURIComponent(boardId)}/messages/live`;
  return afterSequence >= 0 ? `${path}?afterSequence=${String(afterSequence)}` : path;
}

/**
 * Streams one board's communication messages over WebSocket, with safe
 * reconnection — structurally the same reconnect/backoff/dedup discipline
 * as `useTaskEvents`, but deliberately a separate hook (not a shared
 * generic) operating on `CommunicationMessage`, never on
 * `NormalizedAgentEvent`: pretending a communication message is an agent
 * event (or vice versa) would blur two domains that are validated,
 * sequenced, and reasoned about independently. See
 * `docs/architecture/0007-communication-boards.md`, "Replay and delivery
 * guarantee".
 */
export function useBoardMessages(
  boardId: string | null,
  wsBaseUrl: string,
): UseBoardMessagesResult {
  const [connectionState, setConnectionState] = useState<BoardConnectionState>("idle");
  const [messages, setMessages] = useState<readonly CommunicationMessage[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const messagesRef = useRef<CommunicationMessage[]>([]);
  const boardIdRef = useRef<string>("");
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
      if (boardId === null) return;
      closeCurrentSocket();
      const generation = generationRef.current;
      setConnectionState("connecting");

      const socket = new WebSocket(buildMessagesUrl(wsBaseUrl, boardId, afterSequence));
      socketRef.current = socket;

      socket.onopen = () => {
        if (generationRef.current !== generation) return;
        setConnectionState("connected");
        // Deliberately does not reset the retry budget here — see
        // use-task-events.ts's identical comment: the connection can still
        // be closed immediately after opening with a retryable code.
      };

      socket.onmessage = (messageEvent: MessageEvent) => {
        if (generationRef.current !== generation) return;
        if (typeof messageEvent.data !== "string") {
          setLastError("Received a non-text message from the board stream.");
          return;
        }

        const outcome = parseAndClassifyIncomingMessage(
          messageEvent.data,
          messagesRef.current,
          boardIdRef.current,
        );

        switch (outcome.kind) {
          case "accepted": {
            const next = [...messagesRef.current, outcome.message];
            messagesRef.current = next;
            setMessages(next);
            reconnectAttemptRef.current = 0;
            setReconnectAttempt(0);
            break;
          }
          case "duplicate":
            break;
          case "gap":
            setLastError("The message stream skipped ahead; reconnecting to catch up.");
            closeCurrentSocket();
            scheduleReconnect(messagesRef.current.length - 1);
            break;
          case "conflict":
            setLastError("The message stream reported conflicting data for this board.");
            closeCurrentSocket();
            setConnectionState("error");
            break;
          case "board-mismatch":
            setLastError("The message stream reported a message for a different board.");
            closeCurrentSocket();
            setConnectionState("error");
            break;
          case "invalid":
            setLastError("The message stream sent a message that could not be understood.");
            closeCurrentSocket();
            setConnectionState("error");
            break;
        }
      };

      socket.onerror = () => {
        if (generationRef.current !== generation) return;
        // The close handler owns the actual state transition/reconnect decision.
      };

      socket.onclose = (closeEvent: CloseEvent) => {
        if (generationRef.current !== generation) return;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socketRef.current = null;

        if (NON_RETRYABLE_CLOSE_CODES.has(closeEvent.code)) {
          setLastError(describeCloseCode(closeEvent.code));
          setConnectionState("error");
          return;
        }
        // Every other code — including 1000, 1006, 4503, and 4504 — is
        // treated as reconnectable: a board discussion has no terminal
        // state, so a "normal" closure here (e.g. a graceful server
        // shutdown) is just as much an outage to recover from as an
        // abnormal one.
        setLastError(describeCloseCode(closeEvent.code));
        scheduleReconnect(messagesRef.current.length - 1);
      };
    },
    [boardId, wsBaseUrl, closeCurrentSocket, scheduleReconnect],
  );
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const reconnect = useCallback(() => {
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    setLastError(null);
    connect(messagesRef.current.length - 1);
  }, [clearReconnectTimer, connect]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    generationRef.current += 1;
    clearReconnectTimer();
    closeCurrentSocket();
    messagesRef.current = [];
    setMessages([]);
    setLastError(null);
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    boardIdRef.current = boardId ?? "";

    if (boardId === null) {
      setConnectionState("idle");
      return;
    }

    connect(-1);

    return () => {
      generationRef.current += 1;
      clearReconnectTimer();
      closeCurrentSocket();
    };
  }, [boardId, wsBaseUrl, connect, clearReconnectTimer, closeCurrentSocket]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return {
    connectionState,
    messages,
    lastContiguousSequence: messages.length - 1,
    lastError,
    reconnectAttempt,
    reconnect,
  };
}

function describeCloseCode(code: number): string {
  switch (code) {
    case CLOSE_CODE_SUBSCRIBER_LIMIT:
      return "Too many viewers are already watching this board; retrying shortly.";
    case CLOSE_CODE_CLIENT_TOO_SLOW:
      return "Live updates fell behind; reconnecting to catch up.";
    case CLOSE_CODE_ABNORMAL:
      return "The connection to Hall Core was lost; reconnecting.";
    case CLOSE_CODE_INVALID_QUERY:
      return "The message stream request was invalid.";
    case CLOSE_CODE_UNKNOWN_BOARD:
      return "This board no longer exists.";
    case CLOSE_CODE_UNSUPPORTED_DATA:
      return "The message stream connection was closed by the server.";
    case CLOSE_CODE_ORIGIN_NOT_ALLOWED:
      return "Hall Core did not allow this page to connect.";
    default:
      return "Live updates disconnected; reconnecting.";
  }
}
