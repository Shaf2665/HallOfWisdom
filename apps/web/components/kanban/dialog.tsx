"use client";

import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A small, hand-built accessible dialog (`role="dialog"`, `aria-modal`,
 * initial focus, Escape to close, a focus trap, and focus restored to
 * whatever was focused before opening) — not the native `<dialog>`
 * element. `showModal()`/focus-trapping behavior in `<dialog>` is not
 * reliably testable under jsdom, and this project has already established
 * (Phase 6) hand-building small accessible primitives rather than taking
 * on that risk for one dialog. The full-viewport backdrop also prevents
 * background interaction: it captures every click, so nothing behind it
 * is reachable by pointer while open.
 */
export function Dialog({
  titleId,
  onClose,
  children,
}: {
  readonly titleId: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const initial = container
      ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
          (el) => !el.hasAttribute("disabled"),
        )
      : undefined;
    initial?.focus();

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !container) return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute("disabled"),
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedRef.current?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-lg border border-stone-200 bg-white p-4 shadow-xl dark:border-stone-800 dark:bg-stone-900"
      >
        {children}
      </div>
    </div>
  );
}
