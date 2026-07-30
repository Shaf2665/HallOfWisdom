"use client";

import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CardAction } from "../../lib/kanban";
import { computeMenuPosition, type MenuPosition } from "./move-menu-position";

/** Off-screen placeholder used only for the one-frame measurement pass before the real position is known — see the `useLayoutEffect` below. Never visible: paired with `visibility: hidden`. */
const MEASURING_POSITION: MenuPosition = { top: -9999, left: -9999 };

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
 * from that ancestor's clipping box entirely.
 *
 * Positioning (Phase 14.2): `computeMenuPosition` (a pure, unit-tested
 * function — see `move-menu-position.ts`) flips the popover above the
 * trigger when there isn't room below, and clamps both axes to stay
 * within the viewport with a small margin, so a card accumulated far down
 * a very long column never renders its popover off-screen. The menu
 * mounts once at an off-screen `MEASURING_POSITION` (paired with
 * `visibility: hidden`) so its real rendered size can be measured via
 * `getBoundingClientRect()` before computing where it actually belongs —
 * a single, pre-paint `useLayoutEffect` pass, so there's no visible
 * flash at the wrong spot. Position recomputes (not just closes) on
 * scroll/resize while open, tracking the trigger instead of abandoning
 * the disclosure — a deliberate change from the original "close on any
 * scroll" behavior, which this phase found could itself trigger a
 * runaway page scroll: focusing the first menu item for keyboard users
 * (see below) makes the browser try to scroll a `position: fixed`
 * element into view, which does nothing useful for a viewport-relative
 * element but could scroll the *page* by thousands of pixels on a long
 * board, leaving the popover's own computed position stale relative to
 * the trigger's new on-screen location. `{ preventScroll: true }` on that
 * focus call (below) stops the browser from doing this at all — the menu
 * is already correctly positioned within the viewport by the time
 * anything is focused, so there is nothing to scroll to.
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
  const [position, setPosition] = useState<MenuPosition>(MEASURING_POSITION);
  const [measured, setMeasured] = useState(false);
  const internalRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const recalculate = (): void => {
    if (!internalRef.current || !menuRef.current) return;
    const triggerRect = internalRef.current.getBoundingClientRect();
    const menuRect = menuRef.current.getBoundingClientRect();
    setPosition(
      computeMenuPosition(
        triggerRect,
        { width: menuRect.width, height: menuRect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  };

  // Mounts the portal at `MEASURING_POSITION` (off-screen, hidden) first,
  // then measures the trigger and the menu's own rendered size in this
  // same pre-paint pass to compute the real position — see the class doc
  // comment. `measured` resets to `false` on every open so a reopen at a
  // possibly-different trigger location always remeasures rather than
  // reusing a stale position.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(MEASURING_POSITION);
      setMeasured(false);
      return;
    }
    recalculate();
    setMeasured(true);
  }, [open]);

  useEffect(() => {
    if (!open || !measured) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [open, measured]);

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
    // Tracks the trigger instead of closing — see the class doc comment
    // for why "close on any scroll" was replaced. `capture: true` because
    // scroll events on descendant elements (e.g. a Kanban column's own
    // `<ul>`) do not bubble to `window` otherwise.
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("scroll", recalculate, true);
    window.addEventListener("resize", recalculate);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("scroll", recalculate, true);
      window.removeEventListener("resize", recalculate);
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
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              style={{
                top: position.top,
                left: position.left,
                visibility: measured ? "visible" : "hidden",
              }}
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
