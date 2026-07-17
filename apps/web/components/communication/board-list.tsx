import type { CommunicationBoard } from "@hall-of-wisdom/protocol";
import { EmptyState } from "../empty-state";

export type BoardListState = "loading" | "ready" | "error";

/** A collapsed, opt-in diagnostic — never the primary visible label for a board (see the Kanban spec's "no absolute paths or internal IDs as the primary label"). */
function BoardIdDiagnostic({ boardId }: { readonly boardId: string }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300">
        Board ID
      </summary>
      <p className="mt-0.5 font-mono text-xs break-all text-stone-500 dark:text-stone-400">
        {boardId}
      </p>
    </details>
  );
}

function BoardListItem({
  board,
  selected,
  onSelect,
}: {
  readonly board: CommunicationBoard;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={`flex w-full flex-col gap-1 rounded border px-3 py-2 text-left text-sm transition-colors ${
          selected
            ? "border-amber-600 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/40"
            : "border-stone-200 bg-white hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:hover:bg-stone-800"
        }`}
      >
        <span className="font-medium">{board.title}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-500 dark:text-stone-400">
          {board.kind === "task" && board.projectId ? (
            <>
              <span>{board.projectId}</span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span>
            {board.messageCount} message{board.messageCount === 1 ? "" : "s"}
          </span>
          <span aria-hidden="true">·</span>
          <span>Updated {new Date(board.updatedAt).toLocaleString()}</span>
        </span>
        <BoardIdDiagnostic boardId={board.boardId} />
      </button>
    </li>
  );
}

export function BoardList({
  state,
  boards,
  selectedBoardId,
  onSelect,
  onRefresh,
}: {
  readonly state: BoardListState;
  readonly boards: readonly CommunicationBoard[];
  readonly selectedBoardId: string | null;
  readonly onSelect: (boardId: string) => void;
  readonly onRefresh: () => void;
}) {
  return (
    <section aria-labelledby="boards-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="boards-heading" className="text-lg font-semibold">
          Boards
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
        >
          Refresh
        </button>
      </div>

      {state === "loading" && boards.length === 0 ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">Loading boards…</p>
      ) : state === "error" && boards.length === 0 ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Boards could not be loaded.
        </p>
      ) : boards.length === 0 ? (
        <EmptyState message="No boards yet." />
      ) : (
        <>
          {state === "error" ? (
            <p
              role="status"
              className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
            >
              Could not refresh boards. Showing the last known list.
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {boards.map((board) => (
              <BoardListItem
                key={board.boardId}
                board={board}
                selected={board.boardId === selectedBoardId}
                onSelect={() => {
                  onSelect(board.boardId);
                }}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
