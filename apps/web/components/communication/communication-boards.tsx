"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { listBoards } from "../../lib/api-client";
import type { CommunicationBoard } from "../../lib/api-schemas";
import { useBoardMessages, type BoardConnectionState } from "../../hooks/use-board-messages";
import { BoardList, type BoardListState } from "./board-list";
import { MessageList } from "./message-list";
import { MessageComposer } from "./message-composer";

const CONNECTION_LABELS: Record<BoardConnectionState, string> = {
  idle: "No board selected",
  connecting: "Connecting to live updates…",
  connected: "Live",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  error: "Stream error",
};

const CONNECTION_DOT_CLASSES: Record<BoardConnectionState, string> = {
  idle: "bg-stone-300 dark:bg-stone-600",
  connecting: "bg-amber-400",
  connected: "bg-emerald-500",
  reconnecting: "bg-amber-400",
  disconnected: "bg-stone-400",
  error: "bg-red-500",
};

/**
 * Hall Core remains authoritative and this app polls nothing on an
 * interval here: the board list is fetched once on mount and refreshed
 * manually or on window focus — the Kanban spec's "no aggressive polling"
 * guidance applies here too, and a board's own `messageCount`/`updatedAt`
 * only need to be eventually consistent (unlike task status, which the
 * Kanban board polls specifically to reflect execution progress).
 */
export function CommunicationBoards({
  baseUrl,
  wsBaseUrl,
}: {
  readonly baseUrl: string;
  readonly wsBaseUrl: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedBoardId = searchParams.get("boardId");

  const [boards, setBoards] = useState<readonly CommunicationBoard[]>([]);
  const [boardsState, setBoardsState] = useState<BoardListState>("loading");

  const loadBoards = useCallback(() => {
    setBoardsState((current) => (current === "ready" ? current : "loading"));
    listBoards(baseUrl)
      .then((response) => {
        setBoards(response.boards);
        setBoardsState("ready");
      })
      .catch(() => {
        // Existing boards remain visible — only the state flips to
        // "error" (and only shown as a warning) when nothing has ever
        // loaded yet; see BoardList's rendering of `boardsState`.
        setBoardsState("error");
      });
  }, [baseUrl]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    loadBoards();
    function handleFocus(): void {
      loadBoards();
    }
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [loadBoards]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // General is always boards[0] (server-guaranteed ordering — see
  // BoardStore.list()) so falling back to it needs no separate constant
  // duplicated on the client.
  const selectedBoardId =
    requestedBoardId !== null && boards.some((board) => board.boardId === requestedBoardId)
      ? requestedBoardId
      : (boards[0]?.boardId ?? null);
  const selectedBoard = boards.find((board) => board.boardId === selectedBoardId) ?? null;

  function handleSelect(boardId: string): void {
    router.replace(`/boards?boardId=${encodeURIComponent(boardId)}`);
  }

  const { connectionState, messages, reconnectAttempt, lastError, reconnect } = useBoardMessages(
    selectedBoardId,
    wsBaseUrl,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">Communication Boards</h2>
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Local-only, in-memory — boards and messages are cleared when Hall Core restarts.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        <div className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
          <BoardList
            state={boardsState}
            boards={boards}
            selectedBoardId={selectedBoardId}
            onSelect={handleSelect}
            onRefresh={loadBoards}
          />
        </div>

        <div className="flex min-h-[24rem] flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
          {selectedBoard ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 pb-2 dark:border-stone-800">
                <div>
                  <h3 className="text-base font-semibold">{selectedBoard.title}</h3>
                  {selectedBoard.kind === "task" && selectedBoard.projectId ? (
                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      {selectedBoard.projectId}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    aria-live="polite"
                    className="flex items-center gap-1.5 text-xs text-stone-600 dark:text-stone-300"
                  >
                    <span
                      aria-hidden="true"
                      className={`inline-block h-2 w-2 rounded-full ${CONNECTION_DOT_CLASSES[connectionState]}`}
                    />
                    <span>
                      {CONNECTION_LABELS[connectionState]}
                      {connectionState === "reconnecting" && reconnectAttempt > 0
                        ? ` (attempt ${String(reconnectAttempt)})`
                        : ""}
                    </span>
                  </span>
                  {connectionState === "disconnected" || connectionState === "error" ? (
                    <button
                      type="button"
                      onClick={reconnect}
                      className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
                    >
                      Reconnect
                    </button>
                  ) : null}
                </div>
              </div>
              {lastError ? (
                <p role="status" className="text-xs text-stone-500 dark:text-stone-400">
                  {lastError}
                </p>
              ) : null}
              <MessageList messages={messages} />
              <MessageComposer baseUrl={baseUrl} boardId={selectedBoard.boardId} />
            </>
          ) : (
            <p className="text-sm text-stone-500 dark:text-stone-400">
              {boardsState === "loading" ? "Loading boards…" : "No board selected."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
