"use client";

import { forwardRef, useEffect, useId, useRef, useState } from "react";
import type { CardAction } from "../../lib/kanban";

/**
 * A small, native-button-based action disclosure — not a `<select>`,
 * since these are actions ("Start task", "Cancel task"), not a single
 * value being chosen. The trigger button ref is forwarded so a card can
 * return focus to it after an operation settles (not merely when the
 * menu closes), per the Kanban spec's accessibility requirements.
 *
 * Deliberately NOT `role="menu"`/`role="menuitem"`: that ARIA pattern
 * requires arrow-key/Home/End roving-tabindex navigation, which this
 * disclosure doesn't implement — items are just ordinary Tab stops. Using
 * the menu role without the matching keyboard behavior would announce a
 * false affordance to screen-reader users, so this is presented as a
 * plain popover of buttons instead (found in accessibility review).
 */
export const MoveMenu = forwardRef<
  HTMLButtonElement,
  {
    readonly actions: readonly CardAction[];
    readonly onAction: (action: CardAction) => void;
    readonly disabled?: boolean;
    readonly label?: string;
  }
>(function MoveMenu({ actions, onAction, disabled = false, label = "Actions" }, forwardedRef) {
  const [open, setOpen] = useState(false);
  const internalRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
        internalRef.current?.focus();
      }
    }
    function handlePointerDown(event: MouseEvent): void {
      if (!internalRef.current?.parentElement?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div className="relative inline-block">
      <button
        ref={(node) => {
          internalRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="rounded border border-stone-300 px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
      >
        {label}
      </button>
      {open ? (
        <div
          id={menuId}
          className="absolute right-0 z-10 mt-1 flex min-w-[10rem] flex-col gap-0.5 rounded border border-stone-300 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900"
        >
          {actions.map((action) => (
            <button
              key={action.kind === "move" ? `move-${action.targetStatus}` : action.kind}
              type="button"
              onClick={() => {
                setOpen(false);
                onAction(action);
              }}
              className="rounded px-2 py-1 text-left text-sm text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});
