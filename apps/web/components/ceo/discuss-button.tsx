"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiClientError, ensureTaskBoard } from "../../lib/api-client";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Hall couldn’t open that discussion.";
}

/**
 * Feature 9 — the one "Discuss" action shared everywhere task/plan work is
 * shown in the Gateway (plan card, execution progress, work results).
 * `ensureTaskBoard` is idempotent and never changes task/plan state — it
 * only guarantees a Communication Board exists before navigating to it,
 * the same call `KanbanBoard`'s own Discuss action already makes.
 */
export function DiscussButton({
  baseUrl,
  taskId,
}: {
  readonly baseUrl: string;
  readonly taskId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { board } = await ensureTaskBoard(baseUrl, taskId);
      router.push(`/boards?boardId=${encodeURIComponent(board.boardId)}`);
    } catch (err) {
      setError(safeMessage(err));
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void handleClick();
        }}
        className="rounded-lg border border-amber-300 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-800 dark:text-amber-100 dark:hover:bg-amber-950/60"
      >
        {busy ? "Opening discussion…" : "Discuss"}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </span>
  );
}
