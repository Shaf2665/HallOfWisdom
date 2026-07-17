"use client";

import { useState, type KeyboardEvent } from "react";
import { MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH } from "@hall-of-wisdom/protocol";
import { ApiClientError, createBoardMessage } from "../../lib/api-client";

const MAX_MESSAGE_LENGTH = MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH;
const NUL_CHARACTER = String.fromCharCode(0);

type SubmitState = "idle" | "submitting" | "error";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "The message could not be sent.";
}

/**
 * Deliberately never adds the message it sends to any local list — the
 * board's message history (`MessageList`, driven by `useBoardMessages`) is
 * the single source of truth, and it already receives this exact message
 * back over the already-subscribed live WebSocket moments after this POST
 * resolves (or via replay on the next reconnect if the stream happened to
 * be briefly down). This is what keeps the composer from ever displaying
 * an unsaved message as though it were confirmed, and needs no separate
 * reconciliation/dedup logic here — the hook's own sequence-based dedup
 * already covers it.
 */
export function MessageComposer({
  baseUrl,
  boardId,
}: {
  readonly baseUrl: string;
  readonly boardId: string;
}) {
  const [text, setText] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const trimmed = text.trim();
  const isBlank = trimmed.length === 0;
  const isOversized = text.length > MAX_MESSAGE_LENGTH;
  const hasNul = text.includes(NUL_CHARACTER);
  const submitting = submitState === "submitting";
  const canSubmit = !submitting && !isBlank && !isOversized && !hasNul;

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitState("submitting");
    setErrorMessage(null);
    try {
      await createBoardMessage(baseUrl, boardId, text);
      setText("");
      setSubmitState("idle");
      setAnnouncement("Message sent.");
    } catch (error) {
      setErrorMessage(safeMessage(error));
      setSubmitState("error");
      setAnnouncement("Message could not be sent.");
      // Text is deliberately preserved (not cleared) on failure.
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSubmit();
    }
    // A plain Enter keypress is left untouched — the textarea's native
    // behavior (insert a newline) applies.
  }

  return (
    <form
      className="flex flex-col gap-2 border-t border-stone-200 pt-3 dark:border-stone-800"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <label htmlFor="message-composer-text" className="text-sm font-medium">
        Write a message
      </label>
      <textarea
        id="message-composer-text"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        disabled={submitting}
        rows={3}
        aria-describedby="message-composer-hint message-composer-error"
        aria-invalid={errorMessage !== null || isOversized || hasNul ? true : undefined}
        placeholder="Type a message… (Enter for a new line, Ctrl+Enter to send)"
        className="w-full resize-y rounded border border-stone-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id="message-composer-hint" className="text-xs text-stone-500 dark:text-stone-400">
          {text.length}/{MAX_MESSAGE_LENGTH} characters — Enter for a new line, Ctrl+Enter (or
          Cmd+Enter) to send.
        </p>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600"
        >
          {submitting ? "Sending…" : "Send"}
        </button>
      </div>
      {isOversized ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          Message is too long ({text.length}/{MAX_MESSAGE_LENGTH} characters).
        </p>
      ) : null}
      {hasNul ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          Message contains an unsupported character.
        </p>
      ) : null}
      {errorMessage ? (
        <p
          id="message-composer-error"
          role="alert"
          className="text-xs text-red-600 dark:text-red-400"
        >
          {errorMessage}
        </p>
      ) : null}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </form>
  );
}
