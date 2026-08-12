"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { CommunicationMessage, MessageAttachment } from "@hall-of-wisdom/protocol";
import { EmptyState } from "../empty-state";

const NEAR_BOTTOM_THRESHOLD_PX = 80;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-stone-500 dark:text-stone-400"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

/**
 * Content always comes from `GET /api/v1/boards/:boardId/attachments/:attachmentId`
 * — the confirmed message never carries a URL, only enough metadata
 * (`attachmentId`, `filename`, `mimeType`, `byteSize`, `kind`) to build this
 * one request. An image renders as a clickable thumbnail (opens the full
 * image in a new tab); a non-image file renders as a compact filename/size
 * card with a native download link.
 */
function AttachmentCard({
  baseUrl,
  boardId,
  attachment,
}: {
  readonly baseUrl: string;
  readonly boardId: string;
  readonly attachment: MessageAttachment;
}) {
  const url = `${baseUrl}/api/v1/boards/${encodeURIComponent(boardId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`;

  if (attachment.kind === "image") {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="inline-block">
        {/* eslint-disable-next-line @next/next/no-img-element -- served by Hall Core, not Next's remote-image optimizer */}
        <img
          src={url}
          alt={attachment.filename}
          className="h-24 w-24 rounded border border-stone-200 object-cover dark:border-stone-700"
        />
      </a>
    );
  }

  return (
    <a
      href={url}
      download={attachment.filename}
      className="flex items-center gap-2 rounded border border-stone-200 bg-stone-50 p-1.5 pr-3 text-xs hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800"
    >
      <FileIcon />
      <span className="flex flex-col">
        <span className="max-w-[12rem] truncate font-medium text-stone-800 dark:text-stone-200">
          {attachment.filename}
        </span>
        <span className="text-stone-500 dark:text-stone-400">{formatBytes(attachment.byteSize)}</span>
      </span>
    </a>
  );
}

function MessageItem({
  baseUrl,
  message,
}: {
  readonly baseUrl: string;
  readonly message: CommunicationMessage;
}) {
  const planReference =
    message.author.kind === "system" && message.reference?.kind === "ceo_plan_created"
      ? message.reference
      : null;

  return (
    <div className="rounded border border-stone-200 bg-white p-2 text-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-stone-500 dark:text-stone-400">
        <span className="font-medium text-stone-700 dark:text-stone-300">
          {message.author.displayName}
        </span>
        <span>{new Date(message.createdAt).toLocaleString()}</span>
      </div>
      {/* Rendered as plain React text content, never dangerouslySetInnerHTML
          — line breaks are preserved visually via `whitespace-pre-wrap`
          without any Markdown/HTML interpretation; long unbroken runs wrap
          via `break-words` rather than causing horizontal overflow. */}
      {message.text.length > 0 ? (
        <p className="mt-1 break-words whitespace-pre-wrap text-stone-900 dark:text-stone-100">
          {message.text}
        </p>
      ) : null}
      {message.attachments && message.attachments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {message.attachments.map((attachment) => (
            <AttachmentCard
              key={attachment.attachmentId}
              baseUrl={baseUrl}
              boardId={message.boardId}
              attachment={attachment}
            />
          ))}
        </div>
      ) : null}
      {planReference ? (
        <Link
          href={`/ceo/${encodeURIComponent(planReference.planId)}`}
          className="mt-2 inline-flex rounded border border-amber-300 px-2.5 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
        >
          Open plan
        </Link>
      ) : null}
      <p className="mt-1 text-[10px] text-stone-400 dark:text-stone-600">#{message.sequence}</p>
    </div>
  );
}

/**
 * Considerate scrolling (see `docs/architecture/0007-communication-boards.md`,
 * "Scroll behaviour"): jumps to the latest message on first load; while the
 * reader is already near the bottom, a newly arrived message scrolls into
 * view; while they're reading older history, nothing force-scrolls and a
 * "New messages" control appears instead. `prefers-reduced-motion` disables
 * the smooth-scroll animation, using an instant jump instead.
 */
export function MessageList({
  baseUrl,
  messages,
}: {
  readonly baseUrl: string;
  readonly messages: readonly CommunicationMessage[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousCountRef = useRef(0);
  const isFirstRenderRef = useRef(true);
  const [showNewMessagesButton, setShowNewMessagesButton] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  function isNearBottom(): boolean {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
  }

  function scrollToBottom(smooth: boolean): void {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  // Synchronizes scroll position and the polite announcement with an
  // external system (the DOM's own scroll state, `window.matchMedia`) in
  // response to `messages` growing — not state derived from props, so an
  // effect (rather than computing during render) is correct here, the same
  // reasoning `use-task-events.ts` and `kanban-board.tsx`'s own
  // announcement effects document for their identical pattern.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const grew = messages.length > previousCountRef.current;
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      previousCountRef.current = messages.length;
      scrollToBottom(false);
      return;
    }
    if (grew) {
      const newest = messages[messages.length - 1];
      if (newest) {
        // A bounded, polite announcement of only the delta — never the
        // whole history, so a screen-reader user isn't re-read every
        // existing message on each arrival.
        setAnnouncement(`New message from ${newest.author.displayName}.`);
      }
      const reducedMotion =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (isNearBottom()) {
        scrollToBottom(!reducedMotion);
        setShowNewMessagesButton(false);
      } else {
        setShowNewMessagesButton(true);
      }
    }
    previousCountRef.current = messages.length;
  }, [messages]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        className="flex h-full flex-col gap-2 overflow-y-auto p-1"
        onScroll={() => {
          if (isNearBottom()) setShowNewMessagesButton(false);
        }}
      >
        {messages.length === 0 ? (
          <EmptyState message="No messages yet. Start the discussion." />
        ) : (
          messages.map((message) => (
            <MessageItem key={message.messageId} baseUrl={baseUrl} message={message} />
          ))
        )}
      </div>
      {showNewMessagesButton ? (
        <button
          type="button"
          onClick={() => {
            scrollToBottom(true);
            setShowNewMessagesButton(false);
          }}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-amber-700 px-3 py-1 text-xs font-medium text-white shadow hover:bg-amber-800 dark:bg-amber-600"
        >
          New messages
        </button>
      ) : null}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
