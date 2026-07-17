"use client";

import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CardAction } from "../../lib/kanban";

interface MenuPosition {
  readonly top: number;
  readonly right: number;
}

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
 *
 * The open popover is rendered through a portal into `document.body`,
 * `position: fixed`, with its coordinates computed from the trigger's own
 * `getBoundingClientRect()` — not as a plain `position: absolute` child of
 * the trigger. Each Kanban column's card list (`KanbanColumn`'s `<ul>`) is
 * `overflow-y-auto` so long columns scroll; a plain absolutely-positioned
 * child is clipped by that ancestor's overflow box the moment a card sits
 * near the bottom of the visible list, silently hiding the popover's own
 * items from mouse/touch hit-testing (confirmed live via
 * `document.elementFromPoint()` landing on the column's `<section>`
 * instead of the button — found during Phase 7.2's genuine Playwright
 * verification, not caught by any component test since jsdom doesn't
 * lay out or clip anything). Keyboard users were never affected (Tab
 * still reaches a clipped-but-present element), which is exactly why this
 * escaped every prior review. Escaping via a portal removes the popover
 * from that ancestor's clipping box entirely; the menu closes on any
 * scroll or resize while open rather than trying to track a moving
 * target, which is simpler and sufficient here (nothing else keeps a
 * disclosure open across a scroll).
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
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const internalRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open || !internalRef.current) return;
    const rect = internalRef.current.getBoundingClientRect();
    setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }, [open]);

  // Portaling the popover to `document.body` (see the class doc comment)
  // moves it out of DOM order relative to the trigger, which breaks plain
  // sequential Tab navigation into it: without this, Tab from the trigger
  // would land on whatever follows it in `document.body` order (typically
  // the next card), not the first menu item, making the menu unreachable
  // by keyboard. Keyed on `position` (not `open`): the portal only mounts
  // once `position` is set by the `useLayoutEffect` above, one render
  // after `open` itself flips to `true` — an effect keyed on `open` alone
  // would fire on that first, portal-less render and find no menu button
  // to focus, then never fire again on the second render since `open`
  // hasn't changed between the two. A fresh `{ top, right }` object is set
  // on every open (even reopening at the same position), so its reference
  // changes each time and this effect reliably re-fires per open.
  useEffect(() => {
    if (!open || !position) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
        internalRef.current?.focus();
      }
    }
    function handlePointerDown(event: MouseEvent): void {
      const target = event.target as Node;
      if (internalRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleScrollOrResize(): void {
      setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    // `capture: true` because scroll events on descendant elements (e.g. a
    // Kanban column's own `<ul>`) do not bubble to `window` otherwise.
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
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
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              style={{ top: position.top, right: position.right }}
              className="fixed z-50 flex min-w-[10rem] flex-col gap-0.5 rounded border border-stone-300 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900"
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});
