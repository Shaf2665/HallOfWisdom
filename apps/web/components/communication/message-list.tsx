"use client";

import { useEffect, useRef, useState } from "react";
import type { CommunicationMessage } from "@hall-of-wisdom/protocol";
import { EmptyState } from "../empty-state";

const NEAR_BOTTOM_THRESHOLD_PX = 80;

function MessageItem({ message }: { readonly message: CommunicationMessage }) {
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
      <p className="mt-1 break-words whitespace-pre-wrap text-stone-900 dark:text-stone-100">
        {message.text}
      </p>
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
export function MessageList({ messages }: { readonly messages: readonly CommunicationMessage[] }) {
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
          messages.map((message) => <MessageItem key={message.messageId} message={message} />)
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
