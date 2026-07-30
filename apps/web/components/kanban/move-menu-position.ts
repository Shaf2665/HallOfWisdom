/**
 * Pure, dependency-injected positioning geometry for `MoveMenu`'s portaled
 * popover — kept separate from the component so its flip/shift/clamp
 * behavior can be unit-tested deterministically (no real DOM layout, no
 * jsdom `getBoundingClientRect` limitations), per Phase 14.2. Injected
 * rects/viewport, not `window`/live DOM reads, are the parameters here;
 * the component supplies real measurements at call sites.
 */

export interface Rect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface MenuPosition {
  readonly top: number;
  readonly left: number;
}

/** Minimum breathing room kept between the popover and every viewport edge. */
export const VIEWPORT_MARGIN = 8;

/** Gap between the trigger and the popover on the preferred (below) side. */
const TRIGGER_GAP = 4;

/**
 * Computes a `position: fixed` `{top, left}` for the popover that:
 *   1. Opens below the trigger when there's room.
 *   2. Flips above the trigger when there isn't room below but there is
 *      above.
 *   3. If neither side fully fits, picks whichever side has more room,
 *      then clamps — never lets the flip decision itself produce an
 *      off-viewport result.
 *   4. Shifts horizontally (right-aligned to the trigger by default,
 *      matching the trigger's own visual alignment) to stay fully inside
 *      the viewport, with `VIEWPORT_MARGIN` preserved on every edge.
 *
 * `triggerRect` and `viewport` must be freshly measured by the caller —
 * this function has no DOM access and performs no measurement itself.
 */
export function computeMenuPosition(
  triggerRect: Rect,
  menuSize: Size,
  viewport: Viewport,
  margin: number = VIEWPORT_MARGIN,
): MenuPosition {
  const spaceBelow = viewport.height - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  const fitsBelow = spaceBelow >= menuSize.height + margin;
  const fitsAbove = spaceAbove >= menuSize.height + margin;
  const openBelow = fitsBelow || !fitsAbove || spaceBelow >= spaceAbove;

  const rawTop = openBelow
    ? triggerRect.bottom + TRIGGER_GAP
    : triggerRect.top - TRIGGER_GAP - menuSize.height;

  const maxTop = Math.max(margin, viewport.height - menuSize.height - margin);
  const top = Math.min(Math.max(rawTop, margin), maxTop);

  const rawLeft = triggerRect.right - menuSize.width;
  const maxLeft = Math.max(margin, viewport.width - menuSize.width - margin);
  const left = Math.min(Math.max(rawLeft, margin), maxLeft);

  return { top, left };
}
