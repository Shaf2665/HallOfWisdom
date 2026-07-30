import { describe, expect, it } from "vitest";
import { computeMenuPosition, VIEWPORT_MARGIN } from "./move-menu-position";

const VIEWPORT = { width: 1280, height: 900 };
const MENU = { width: 160, height: 120 };

function rect(top: number, left: number, width = 60, height = 28) {
  return { top, left, right: left + width, bottom: top + height };
}

describe("computeMenuPosition", () => {
  it("opens below the trigger when there is enough room", () => {
    const trigger = rect(100, 500);
    const position = computeMenuPosition(trigger, MENU, VIEWPORT);
    expect(position.top).toBe(trigger.bottom + 4);
  });

  it("flips above the trigger when there is insufficient space below", () => {
    const trigger = rect(VIEWPORT.height - 40, 500);
    const position = computeMenuPosition(trigger, MENU, VIEWPORT);
    expect(position.top).toBe(trigger.top - 4 - MENU.height);
    expect(position.top).toBeLessThan(trigger.top);
  });

  it("clamps to the bottom margin when neither side fully fits and below has more room", () => {
    const shortViewport = { width: 1280, height: 140 };
    const trigger = rect(60, 500, 60, 20);
    const position = computeMenuPosition(trigger, MENU, shortViewport);
    expect(position.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(position.top + MENU.height).toBeLessThanOrEqual(shortViewport.height - VIEWPORT_MARGIN);
  });

  it("right-aligns to the trigger by default (matches the trigger's own right edge)", () => {
    const trigger = rect(100, 500, 60, 28);
    const position = computeMenuPosition(trigger, MENU, VIEWPORT);
    expect(position.left).toBe(trigger.right - MENU.width);
  });

  it("shifts left to stay inside the right viewport edge when the trigger is near it", () => {
    const trigger = rect(100, VIEWPORT.width - 20, 60, 28);
    const position = computeMenuPosition(trigger, MENU, VIEWPORT);
    expect(position.left + MENU.width).toBeLessThanOrEqual(VIEWPORT.width - VIEWPORT_MARGIN);
  });

  it("remains inside the left viewport edge when the trigger is near it", () => {
    const trigger = rect(100, 2, 60, 28);
    const position = computeMenuPosition(trigger, MENU, VIEWPORT);
    expect(position.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  });

  it("never produces a left position that would overflow the viewport horizontally", () => {
    const trigger = rect(100, VIEWPORT.width + 500, 60, 28);
    const position = computeMenuPosition(trigger, MENU, VIEWPORT);
    expect(position.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(position.left + MENU.width).toBeLessThanOrEqual(
      VIEWPORT.width - VIEWPORT_MARGIN + 0.001,
    );
  });

  it("clamps a trigger far above the viewport (negative top) to the top margin", () => {
    const trigger = rect(-3884, 418, 60, 26);
    const position = computeMenuPosition(trigger, MENU, VIEWPORT);
    expect(position.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(position.top + MENU.height).toBeLessThanOrEqual(VIEWPORT.height - VIEWPORT_MARGIN);
  });

  it("clamps a trigger far below the viewport to the bottom margin", () => {
    const trigger = rect(VIEWPORT.height + 4000, 418, 60, 26);
    const position = computeMenuPosition(trigger, MENU, VIEWPORT);
    expect(position.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(position.top + MENU.height).toBeLessThanOrEqual(VIEWPORT.height - VIEWPORT_MARGIN);
  });

  it("reproduces the exact Phase 14.2 full-suite failure geometry and now stays fully in-viewport", () => {
    // The real trigger/viewport numbers captured live from the reproduced
    // `ceo-plans.spec.ts` full-suite failure (Phase 14.2 investigation):
    // a 1280x1400 viewport, a trigger scrolled far out of view above the
    // fold, and a menu that used to render 134px past the viewport
    // bottom.
    const viewport = { width: 1280, height: 1400 };
    const trigger = rect(-3884, 418, 58.5, 26);
    const menu = { width: 155, height: 188 };
    const position = computeMenuPosition(trigger, menu, viewport);
    expect(position.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(position.top + menu.height).toBeLessThanOrEqual(viewport.height - VIEWPORT_MARGIN);
    expect(position.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(position.left + menu.width).toBeLessThanOrEqual(viewport.width - VIEWPORT_MARGIN);
  });
});
