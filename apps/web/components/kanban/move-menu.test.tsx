import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CardAction } from "../../lib/kanban";
import { MoveMenu } from "./move-menu";

afterEach(() => {
  cleanup();
});

const ACTIONS: readonly CardAction[] = [
  { kind: "move", targetStatus: "ready", label: "Move to Ready" },
  { kind: "find-agent", label: "Find suitable agent" },
];

/** The portaled popover's own fixed-positioned container, ascended from one of its item buttons. */
function menuContainerFor(item: HTMLElement): HTMLElement {
  const container = item.closest<HTMLElement>('[class*="fixed"]');
  if (!container) throw new Error("expected the item to be inside the portaled menu container");
  return container;
}

/**
 * `getBoundingClientRect` is always zero in jsdom. Distinguishes the
 * trigger (a `<button>` carrying `aria-expanded`) from the portaled menu
 * container (the `div` with the `fixed` class) so each test can control
 * their geometry independently, the same way the real browser's layout
 * would — see `move-menu-position.test.ts` for the pure geometry math
 * this wires up.
 */
function mockRects(options: {
  trigger: { top: number; left: number; width?: number; height?: number };
  menu?: { width: number; height: number };
}): void {
  const triggerWidth = options.trigger.width ?? 64;
  const triggerHeight = options.trigger.height ?? 26;
  const menuSize = options.menu ?? { width: 160, height: 64 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.hasAttribute("aria-expanded")) {
      return {
        top: options.trigger.top,
        left: options.trigger.left,
        right: options.trigger.left + triggerWidth,
        bottom: options.trigger.top + triggerHeight,
        width: triggerWidth,
        height: triggerHeight,
        x: options.trigger.left,
        y: options.trigger.top,
        toJSON: () => ({}),
      };
    }
    if (this.className.includes("fixed")) {
      const styleTop = Number.parseFloat(this.style.top) || 0;
      const styleLeft = Number.parseFloat(this.style.left) || 0;
      return {
        top: styleTop,
        left: styleLeft,
        right: styleLeft + menuSize.width,
        bottom: styleTop + menuSize.height,
        width: menuSize.width,
        height: menuSize.height,
        x: styleLeft,
        y: styleTop,
        toJSON: () => ({}),
      };
    }
    return {
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  });
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1280, writable: true, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 900, writable: true, configurable: true });
});

describe("MoveMenu", () => {
  it("opens below the trigger when there is enough room below it", async () => {
    mockRects({ trigger: { top: 100, left: 500 } });
    const user = userEvent.setup();
    render(<MoveMenu actions={ACTIONS} onAction={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const item = await screen.findByRole("button", { name: "Move to Ready" });
    const container = menuContainerFor(item);
    await waitFor(() => {
      expect(Number.parseFloat(container.style.top)).toBeCloseTo(130, 0);
    });
  });

  it("flips above the trigger when there is insufficient space below", async () => {
    mockRects({ trigger: { top: 870, left: 500 }, menu: { width: 160, height: 64 } });
    const user = userEvent.setup();
    render(<MoveMenu actions={ACTIONS} onAction={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const item = await screen.findByRole("button", { name: "Move to Ready" });
    const container = menuContainerFor(item);
    await waitFor(() => {
      const top = Number.parseFloat(container.style.top);
      expect(top).toBeLessThan(870);
    });
  });

  it("stays fully inside the viewport (no page-level overflow) for a trigger scrolled far above the fold", async () => {
    mockRects({ trigger: { top: -3884, left: 418 }, menu: { width: 160, height: 188 } });
    const user = userEvent.setup();
    render(<MoveMenu actions={ACTIONS} onAction={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const item = await screen.findByRole("button", { name: "Move to Ready" });
    const container = menuContainerFor(item);
    await waitFor(() => {
      const top = Number.parseFloat(container.style.top);
      const left = Number.parseFloat(container.style.left);
      expect(top).toBeGreaterThanOrEqual(8);
      expect(top + 188).toBeLessThanOrEqual(900 - 8);
      expect(left).toBeGreaterThanOrEqual(8);
      expect(left + 160).toBeLessThanOrEqual(1280 - 8);
    });
  });

  it("shifts left to remain inside the viewport when the trigger is near the right edge", async () => {
    mockRects({ trigger: { top: 100, left: 1260 }, menu: { width: 160, height: 64 } });
    const user = userEvent.setup();
    render(<MoveMenu actions={ACTIONS} onAction={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const item = await screen.findByRole("button", { name: "Move to Ready" });
    const container = menuContainerFor(item);
    await waitFor(() => {
      const left = Number.parseFloat(container.style.left);
      expect(left + 160).toBeLessThanOrEqual(1280 - 8);
    });
  });

  it("recalculates position on window resize while open", async () => {
    mockRects({ trigger: { top: 100, left: 500 } });
    const user = userEvent.setup();
    render(<MoveMenu actions={ACTIONS} onAction={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await screen.findByRole("button", { name: "Move to Ready" });

    Object.defineProperty(window, "innerHeight", {
      value: 120,
      configurable: true,
      writable: true,
    });
    mockRects({ trigger: { top: 100, left: 500 }, menu: { width: 160, height: 64 } });
    window.dispatchEvent(new Event("resize"));

    const item = await screen.findByRole("button", { name: "Move to Ready" });
    const container = menuContainerFor(item);
    await waitFor(() => {
      const top = Number.parseFloat(container.style.top);
      expect(top + 64).toBeLessThanOrEqual(120 - 8);
    });
  });

  it("recalculates (does not close) on a window scroll event while open", async () => {
    mockRects({ trigger: { top: 100, left: 500 } });
    const user = userEvent.setup();
    render(<MoveMenu actions={ACTIONS} onAction={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await screen.findByRole("button", { name: "Move to Ready" });

    mockRects({ trigger: { top: 400, left: 500 } });
    window.dispatchEvent(new Event("scroll"));

    // Still open and reachable — a scroll no longer closes the menu.
    expect(screen.getByRole("button", { name: "Move to Ready" })).toBeVisible();
  });

  it("Escape closes the menu without invoking any action, and restores focus to the trigger", async () => {
    mockRects({ trigger: { top: 100, left: 500 } });
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<MoveMenu actions={ACTIONS} onAction={onAction} />);
    const trigger = screen.getByRole("button", { name: "Actions" });
    await user.click(trigger);
    await screen.findByRole("button", { name: "Move to Ready" });

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: "Move to Ready" })).not.toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it("closes when a click lands outside the trigger and the menu", async () => {
    mockRects({ trigger: { top: 100, left: 500 } });
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Outside</button>
        <MoveMenu actions={ACTIONS} onAction={vi.fn()} />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await screen.findByRole("button", { name: "Move to Ready" });

    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(screen.queryByRole("button", { name: "Move to Ready" })).not.toBeInTheDocument();
  });

  it("a disabled trigger cannot be opened or activated", async () => {
    mockRects({ trigger: { top: 100, left: 500 } });
    const user = userEvent.setup();
    render(<MoveMenu actions={ACTIONS} onAction={vi.fn()} disabled />);
    const trigger = screen.getByRole("button", { name: "Actions" });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole("button", { name: "Move to Ready" })).not.toBeInTheDocument();
  });

  it("selecting an item closes the menu and invokes onAction exactly once with that action", async () => {
    mockRects({ trigger: { top: 100, left: 500 } });
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<MoveMenu actions={ACTIONS} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(await screen.findByRole("button", { name: "Move to Ready" }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(ACTIONS[0]);
    expect(screen.queryByRole("button", { name: "Move to Ready" })).not.toBeInTheDocument();
  });

  it("two independent MoveMenu instances never both show an open popover — opening one closes the other", async () => {
    mockRects({ trigger: { top: 100, left: 500 } });
    const user = userEvent.setup();
    render(
      <div>
        <MoveMenu actions={ACTIONS} onAction={vi.fn()} label="Actions A" />
        <MoveMenu actions={ACTIONS} onAction={vi.fn()} label="Actions B" />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Actions A" }));
    expect(await screen.findAllByRole("button", { name: "Move to Ready" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Actions B" }));
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Move to Ready" })).toHaveLength(1);
    });
    expect(screen.getByRole("button", { name: "Actions A" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Actions B" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("the portaled menu stays associated with its own trigger via aria-controls/id", async () => {
    mockRects({ trigger: { top: 100, left: 500 } });
    const user = userEvent.setup();
    render(<MoveMenu actions={ACTIONS} onAction={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Actions" });
    await user.click(trigger);
    const item = await screen.findByRole("button", { name: "Move to Ready" });
    const container = item.closest("[id]");
    if (!container) throw new Error("expected the item to be inside an element with an id");
    expect(trigger.getAttribute("aria-controls")).toBe(container.id);
  });

  it("renders nothing (no trigger, no popover) when there are zero actions", () => {
    render(<MoveMenu actions={[]} onAction={vi.fn()} label="Actions" />);
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
  });
});
