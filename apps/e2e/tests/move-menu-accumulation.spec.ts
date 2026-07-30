import { expect, type Page, test } from "@playwright/test";

/**
 * Phase 14.2 — a dedicated regression for the exact failure mode found
 * while investigating `ceo-plans.spec.ts`'s full-suite flakiness: a
 * `MoveMenu` (`apps/web/components/kanban/move-menu.tsx`) popover
 * rendering past the viewport once enough Kanban cards accumulate ahead
 * of the target card. Creates its own batch of cards (so this reproduces
 * reliably in isolation, not only after a long full-suite run), scrolls
 * the target card into view the way a real user would, and interacts
 * with `MoveMenu` through real pointer clicks and real keyboard input
 * only — no DOM-dispatch fallback, no `force: true`, no synthetic event
 * bypass. Run at both a narrow mobile viewport and a normal desktop one,
 * per the phase's requirement.
 */

async function createBacklogTask(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "+ New backlog task" }).click();
  await page.getByLabel("Project").fill("e2e-project");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Description").fill("Accumulation regression filler task.");
  await page.getByRole("button", { name: "Add to Backlog" }).click();
  await expect(page.getByRole("button", { name: `Drag ${title}`, exact: false })).toBeVisible();
}

function cardFor(page: Page, title: string) {
  return page.locator("li", { has: page.getByText(title, { exact: true }) });
}

/**
 * Document-level horizontal overflow check. Originally scoped away from
 * `/board` itself, because `/board`'s columns row could leak past
 * `document.documentElement`'s own width once enough cards accumulated —
 * root-caused in Phase 14.3 to a missing `position: relative` containing
 * block on the columns row (an `sr-only` absolutely-positioned label deep
 * inside a card was leaking its un-scrolled static position into the
 * document's own scrollable-overflow region). That's fixed now
 * (`kanban-board.tsx`'s columns row), so this assertion is safe to run on
 * `/board` directly — see the calls below, which now double as live
 * regression evidence for the Phase 14.3 fix in addition to covering
 * `MoveMenu` itself.
 */
async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
}

/**
 * Creates enough backlog cards that the last one sits well below the
 * fold of even a tall desktop viewport, and returns its unique title.
 */
async function accumulateCardsAndReturnTargetTitle(
  page: Page,
  runId: string,
  count: number,
): Promise<string> {
  await page.goto("/board");
  let targetTitle = "";
  for (let index = 1; index <= count; index += 1) {
    targetTitle = `MoveMenu accumulation ${runId} card ${String(index)}`;
    await createBacklogTask(page, targetTitle);
  }
  return targetTitle;
}

test.describe("MoveMenu stays reachable and fully in-viewport under real card accumulation (Phase 14.2)", () => {
  test("390×844 mobile — Actions/CEO plans reachable by real pointer click and by keyboard, menu never off-screen, no horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const runId = `${Date.now().toString()}-mobile`;
    const targetTitle = await accumulateCardsAndReturnTargetTitle(page, runId, 12);
    const card = cardFor(page, targetTitle);

    // 1. Scroll the target card into view the way a real user would.
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();

    // 2. Open Actions using a real pointer click.
    await card.getByRole("button", { name: "Actions" }).click();

    // 3. Open CEO plans — a real pointer click, no bypass.
    const ceoPlansItem = page.getByRole("button", { name: "CEO plans" });
    await expect(ceoPlansItem).toBeVisible();

    // 4. Confirm the menu remains fully inside the viewport before clicking it.
    const itemBox = await ceoPlansItem.boundingBox();
    expect(itemBox).not.toBeNull();
    if (itemBox) {
      expect(itemBox.x).toBeGreaterThanOrEqual(0);
      expect(itemBox.y).toBeGreaterThanOrEqual(0);
      expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(390);
      expect(itemBox.y + itemBox.height).toBeLessThanOrEqual(844);
    }

    await ceoPlansItem.click();

    // 5. Confirm the intended card was used — the CEO Plans screen for
    // *this* task shows its own title.
    await expect(page).toHaveURL(/\/ceo\?parentTaskId=/);
    await expect(page.getByText(targetTitle)).toBeVisible();
    await assertNoHorizontalOverflow(page);

    // 6. Close and reopen the same card's Actions menu using the
    // keyboard only, from the board. A fresh backlog task's first
    // available action is "Move to Ready" (`availableActionsFor` in
    // `lib/kanban.ts`), not "CEO plans" — the first *enabled* item is
    // exactly what should receive focus per the keyboard/focus contract.
    await page.goto("/board");
    const trigger = cardFor(page, targetTitle).getByRole("button", { name: "Actions" });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const firstItem = page.getByRole("button", { name: "Move to Ready" });
    await expect(firstItem).toBeVisible();
    await expect(firstItem).toBeFocused();
    await expect(page.getByRole("button", { name: "CEO plans" })).toBeVisible();

    const keyboardBox = await firstItem.boundingBox();
    expect(keyboardBox).not.toBeNull();
    if (keyboardBox) {
      expect(keyboardBox.x).toBeGreaterThanOrEqual(0);
      expect(keyboardBox.y).toBeGreaterThanOrEqual(0);
      expect(keyboardBox.x + keyboardBox.width).toBeLessThanOrEqual(390);
      expect(keyboardBox.y + keyboardBox.height).toBeLessThanOrEqual(844);
    }

    // 7. No page-level horizontal overflow on `/board` itself, in
    // addition to the `keyboardBox` viewport bounds already checked above
    // for the popover.
    await assertNoHorizontalOverflow(page);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Move to Ready" })).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test("1440×900 desktop — Actions/CEO plans reachable by real pointer click and by keyboard, menu never off-screen, no horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const runId = `${Date.now().toString()}-desktop`;
    const targetTitle = await accumulateCardsAndReturnTargetTitle(page, runId, 12);
    const card = cardFor(page, targetTitle);

    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();

    await card.getByRole("button", { name: "Actions" }).click();

    const ceoPlansItem = page.getByRole("button", { name: "CEO plans" });
    await expect(ceoPlansItem).toBeVisible();

    const itemBox = await ceoPlansItem.boundingBox();
    expect(itemBox).not.toBeNull();
    if (itemBox) {
      expect(itemBox.x).toBeGreaterThanOrEqual(0);
      expect(itemBox.y).toBeGreaterThanOrEqual(0);
      expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(1440);
      expect(itemBox.y + itemBox.height).toBeLessThanOrEqual(900);
    }

    await ceoPlansItem.click();

    await expect(page).toHaveURL(/\/ceo\?parentTaskId=/);
    await expect(page.getByText(targetTitle)).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await page.goto("/board");
    const trigger = cardFor(page, targetTitle).getByRole("button", { name: "Actions" });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    await page.keyboard.press("Enter");
    // A fresh backlog task's first available action is "Move to Ready"
    // (`availableActionsFor` in `lib/kanban.ts`), not "CEO plans" — the
    // first *enabled* item is exactly what should receive focus per the
    // keyboard/focus contract.
    const firstItem = page.getByRole("button", { name: "Move to Ready" });
    await expect(firstItem).toBeVisible();
    await expect(firstItem).toBeFocused();
    await expect(page.getByRole("button", { name: "CEO plans" })).toBeVisible();

    const keyboardBox = await firstItem.boundingBox();
    expect(keyboardBox).not.toBeNull();
    if (keyboardBox) {
      expect(keyboardBox.x).toBeGreaterThanOrEqual(0);
      expect(keyboardBox.y).toBeGreaterThanOrEqual(0);
      expect(keyboardBox.x + keyboardBox.width).toBeLessThanOrEqual(1440);
      expect(keyboardBox.y + keyboardBox.height).toBeLessThanOrEqual(900);
    }
    // No page-level horizontal overflow on `/board` itself, in addition
    // to the `keyboardBox` viewport bounds already checked above for the
    // popover.
    await assertNoHorizontalOverflow(page);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Move to Ready" })).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });
});
