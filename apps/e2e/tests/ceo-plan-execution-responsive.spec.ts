import { expect, type Page, test } from "@playwright/test";

/**
 * Phase 15.1 kickoff §16 — a REAL, browser-measured 390×844 overflow
 * check for `/ceo/[planId]`'s execution section, closing a gap the
 * phase's own report disclosed: the existing 390×844 coverage for this
 * feature (`kanban-board.test.tsx`'s badge-wrapping assertions) only
 * checks className application under jsdom, which cannot measure real
 * layout overflow (`document.documentElement.scrollWidth` does not exist
 * meaningfully in jsdom). This spec measures the real thing, in a real
 * Chromium viewport, including with a confirm dialog open — the
 * highest-content-density state this page reaches.
 */

async function createBacklogTask(page: Page, title: string, description: string): Promise<void> {
  await page.getByRole("button", { name: "+ New backlog task" }).click();
  await page.getByLabel("Project").fill("e2e-project");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Description").fill(description);
  await page.getByRole("button", { name: "Add to Backlog" }).click();
  await expect(page.getByRole("button", { name: `Drag ${title}`, exact: false })).toBeVisible();
}

async function openActionsMenu(card: ReturnType<Page["locator"]>): Promise<void> {
  const trigger = card.getByRole("button", { name: "Actions" });
  await trigger.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
  });
  await trigger.click();
}

function cardFor(page: Page, title: string) {
  return page.locator("li", { has: page.getByText(title, { exact: true }) });
}

/** Scrolls into view first — at 390px wide, a dialog's own content commonly exceeds the viewport height, and Playwright's built-in auto-scroll does not always reach into a scrollable dialog body. */
async function clickScrolled(locator: ReturnType<Page["getByRole"]>): Promise<void> {
  await locator.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
  });
  await locator.click();
}

async function assertNoHorizontalOverflow(page: Page, viewportWidth: number): Promise<void> {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(viewportWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1); // +1: sub-pixel rounding tolerance
}

test.describe("CEO plan execution — responsive containment (Phase 15.1 kickoff §16)", () => {
  test("390×844 — the execution section, its dialogs, and the delegated-steps list never produce document-level horizontal scroll", async ({
    page,
  }) => {
    // Routing/assignment happens at a desktop viewport first — "Find
    // suitable agent"'s own candidate-comparison table does not fit
    // 390×844's height at all (a genuine, separate vertical-fit issue,
    // out of scope for this HORIZONTAL-overflow-only spec), and
    // delegation requires every step to have a resolved adapter. The
    // viewport switches to 390×844 below, before anything this spec
    // actually cares about measuring.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/board");
    const title = `Responsive execution task ${Date.now().toString()}`;
    await createBacklogTask(page, title, "Verify the export CSV includes the new refund column.");

    const card = cardFor(page, title);
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Move to Ready" }).click();
    await expect(card.getByText("Ready", { exact: true })).toBeVisible();
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Find suitable agent" }).click();
    const routingDialog = page.getByRole("dialog", { name: /Find suitable agent/ });
    await expect(routingDialog.getByText(/Recommended "Claude Code"/)).toBeVisible();
    await routingDialog.getByRole("button", { name: "Route and assign" }).click();
    await expect(card.getByText("Assigned", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalOverflow(page, 390);
    await openActionsMenu(card);
    await clickScrolled(page.getByRole("button", { name: "CEO plans" }));
    await clickScrolled(page.getByRole("button", { name: "Ask CEO to plan" }));
    await clickScrolled(page.getByRole("button", { name: "Create draft plan" }));
    await expect(page).toHaveURL(/\/ceo\/[^/?]+$/);
    await assertNoHorizontalOverflow(page, 390);

    await clickScrolled(page.getByRole("button", { name: "Submit for approval" }));
    await clickScrolled(page.getByRole("button", { name: "Approve…" }));
    const approveDialog = page.getByRole("dialog", { name: /Approve plan version 1/ });
    await assertNoHorizontalOverflow(page, 390);
    await approveDialog.getByRole("checkbox").check();
    await clickScrolled(approveDialog.getByRole("button", { name: "Approve plan" }));
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();

    await clickScrolled(page.getByRole("button", { name: "Delegate…" }));
    const delegateDialog = page.getByRole("dialog");
    await delegateDialog.getByRole("checkbox").check();
    await clickScrolled(delegateDialog.getByRole("button", { name: "Delegate" }));
    await expect(delegateDialog.getByText(/Delegated — 3 child tasks created/)).toBeVisible();
    await assertNoHorizontalOverflow(page, 390);
    await page.keyboard.press("Escape");

    // The execution section itself: Configure dialog, then the
    // "no-run"/"configured" states, then the Start dialog with its full
    // policy `<dl>` — the densest content this page ever renders.
    await clickScrolled(page.getByRole("button", { name: "Configure execution…" }));
    const configureDialog = page.getByRole("dialog", { name: "Configure execution" });
    await assertNoHorizontalOverflow(page, 390);
    await configureDialog
      .getByRole("radio", { name: /Autonomous — the scheduler starts eligible steps/ })
      .check();
    await clickScrolled(configureDialog.getByRole("button", { name: "Configure", exact: true }));
    await expect(configureDialog).not.toBeVisible();
    await assertNoHorizontalOverflow(page, 390);

    await clickScrolled(page.getByRole("button", { name: "Start execution…" }));
    const startDialog = page.getByRole("dialog", { name: /Start execution — plan version 1/ });
    await expect(startDialog).toBeVisible();
    await assertNoHorizontalOverflow(page, 390);
    await clickScrolled(startDialog.getByRole("button", { name: "Cancel", exact: true }));
    await expect(startDialog).not.toBeVisible();

    // The delegated-steps list ("Plan steps" region) at its widest —
    // recommendation text, dependency notes, and every step row's own
    // status badge all render together.
    await assertNoHorizontalOverflow(page, 390);
  });

  /**
   * The prior test never starts a genuinely running execution (it uses the
   * real "Claude Code" routing recommendation, and clicking "Start
   * execution…" for real would invoke a real provider — forbidden). This
   * test uses the same deterministic fixture adapters
   * `ceo-plan-execution-intervention.spec.ts` already established to reach
   * an actively-running state, specifically to measure the three
   * operator-control confirm dialogs that only render once a run exists:
   * Pause, Cancel future scheduling, and Emergency stop — plus the board's
   * own Kanban containment (badges, Actions menu) at the same viewport.
   */
  test("390×844 — Pause/Cancel-future-scheduling/Emergency-stop confirm dialogs and the Kanban board's own badges/menu never produce document-level horizontal scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/board");
    const title = `Responsive dialogs ${Date.now().toString()}`;
    await createBacklogTask(page, title, "Verify the export CSV includes the new refund column.");
    const card = cardFor(page, title);
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Move to Ready" }).click();
    await expect(card.getByText("Ready", { exact: true })).toBeVisible();
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Find suitable agent" }).click();
    await page
      .getByRole("dialog", { name: /Find suitable agent/ })
      .getByRole("button", { name: "Route and assign" })
      .click();
    await expect(card.getByText("Assigned", { exact: true })).toBeVisible();

    await openActionsMenu(card);
    await page.getByRole("button", { name: "CEO plans" }).click();
    await page.getByRole("button", { name: "Ask CEO to plan" }).click();
    await page.getByRole("button", { name: "Create draft plan" }).click();
    await expect(page).toHaveURL(/\/ceo\/[^/?]+$/);
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await page.getByRole("button", { name: "Approve…" }).click();
    const approveDialog = page.getByRole("dialog", { name: /Approve plan version 1/ });
    await approveDialog.getByRole("checkbox").check();
    await approveDialog.getByRole("button", { name: "Approve plan" }).click();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Delegate…" }).click();
    const delegateDialog = page.getByRole("dialog");
    await delegateDialog.getByRole("checkbox").check();
    await delegateDialog.getByRole("button", { name: "Delegate" }).click();
    await expect(delegateDialog.getByText(/Delegated — 3 child tasks created/)).toBeVisible();
    const planUrl = page.url();
    await delegateDialog.getByRole("link", { name: "Go to Kanban board" }).click();
    await expect(page).toHaveURL(/\/board$/);

    async function assignAgent(cardTitle: string, agentLabel: string): Promise<void> {
      const targetCard = cardFor(page, cardTitle);
      await openActionsMenu(targetCard);
      await page.getByRole("button", { name: "Return to Ready" }).click();
      await expect(targetCard.getByText("Ready", { exact: true })).toBeVisible();
      await openActionsMenu(targetCard);
      await page.getByRole("button", { name: "Assign agent" }).click();
      const dialog = page.getByRole("dialog", { name: "Assign an agent" });
      await dialog.getByLabel("Agent").selectOption({ label: agentLabel });
      await dialog.getByRole("button", { name: "Assign", exact: true }).click();
      await expect(dialog).not.toBeVisible();
    }
    await assignAgent(`Investigate: ${title}`, "CEO Execution Fixture (cancellable)");
    await assignAgent(`Implement: ${title}`, "CEO Execution Fixture (success)");
    await assignAgent(`Verify: ${title}`, "CEO Execution Fixture (success)");

    await page.goto(planUrl);
    await page.getByRole("button", { name: "Configure execution…" }).click();
    const configureDialog = page.getByRole("dialog", { name: "Configure execution" });
    await configureDialog
      .getByRole("radio", { name: /Autonomous — the scheduler starts eligible steps/ })
      .check();
    await configureDialog.getByRole("button", { name: "Configure", exact: true }).click();
    await expect(configureDialog).not.toBeVisible();
    await page.getByRole("button", { name: "Start execution…" }).click();
    const startDialog = page.getByRole("dialog", { name: /Start execution — plan version 1/ });
    await startDialog
      .getByRole("checkbox", {
        name: "I authorize Hall to automatically start eligible child tasks under this execution policy.",
      })
      .check();
    await startDialog.getByRole("button", { name: "Start execution", exact: true }).click();
    await expect(startDialog).not.toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Autonomous execution" })
        .getByText(/^Step 1: Investigate:/)
        .locator("..")
        .getByText("Running"),
    ).toBeVisible({ timeout: 30000 });

    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalOverflow(page, 390);

    await clickScrolled(page.getByRole("button", { name: "Pause…" }));
    const pauseDialog = page.getByRole("dialog", { name: "Pause execution?" });
    await expect(pauseDialog).toBeVisible();
    await assertNoHorizontalOverflow(page, 390);
    await page.keyboard.press("Escape");
    await expect(pauseDialog).not.toBeVisible();

    await clickScrolled(page.getByRole("button", { name: "Cancel future scheduling…" }));
    const cancelDialog = page.getByRole("dialog", { name: "Cancel future scheduling?" });
    await expect(cancelDialog).toBeVisible();
    await assertNoHorizontalOverflow(page, 390);
    await page.keyboard.press("Escape");
    await expect(cancelDialog).not.toBeVisible();

    await clickScrolled(page.getByRole("button", { name: "Emergency stop…" }));
    const stopDialog = page.getByRole("dialog", { name: "Emergency stop?" });
    await expect(stopDialog).toBeVisible();
    await assertNoHorizontalOverflow(page, 390);
    // Every touch target inside the tallest of the four confirm dialogs
    // stays reachable without page-level horizontal scroll appearing —
    // check the confirm checkbox and button are both genuinely visible
    // (not just present) at this width.
    await expect(
      stopDialog.getByRole("checkbox", {
        name: "I understand that Hall will attempt to cancel only the active tasks linked to this plan, and that some cancellations may fail.",
      }),
    ).toBeVisible();
    await expect(
      stopDialog.getByRole("button", { name: "Emergency stop", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(stopDialog).not.toBeVisible();

    // The board's own badges and Actions/Move menu — genuinely rendered
    // fresh in this viewport (not carried over from the 1280px layout).
    await page.goto("/board");
    await assertNoHorizontalOverflow(page, 390);
    const boardCard = cardFor(page, title);
    await openActionsMenu(boardCard);
    await assertNoHorizontalOverflow(page, 390);
    await page.keyboard.press("Escape");
  });

  /**
   * 1440×900 — the desktop-density end of the same checklist: the
   * execution timeline/status text is never color-only (every status has
   * a distinct text label, asserted directly rather than by inspecting
   * CSS), a dialog traps focus and returns it to its trigger on close, and
   * every confirmation checkbox begins unchecked. Reuses the same
   * cancellable-fixture flow as the 390×844 dialogs test above.
   */
  test("1440×900 — status is never color-only, dialog focus is trapped and restored, and every confirmation checkbox starts unchecked", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/board");
    const title = `Responsive desktop ${Date.now().toString()}`;
    await createBacklogTask(page, title, "Verify the export CSV includes the new refund column.");
    const card = cardFor(page, title);
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Move to Ready" }).click();
    await expect(card.getByText("Ready", { exact: true })).toBeVisible();
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Find suitable agent" }).click();
    await page
      .getByRole("dialog", { name: /Find suitable agent/ })
      .getByRole("button", { name: "Route and assign" })
      .click();
    await expect(card.getByText("Assigned", { exact: true })).toBeVisible();

    await openActionsMenu(card);
    await page.getByRole("button", { name: "CEO plans" }).click();
    await page.getByRole("button", { name: "Ask CEO to plan" }).click();
    await page.getByRole("button", { name: "Create draft plan" }).click();
    await expect(page).toHaveURL(/\/ceo\/[^/?]+$/);
    await page.getByRole("button", { name: "Submit for approval" }).click();
    const approveTrigger = page.getByRole("button", { name: "Approve…" });
    await approveTrigger.click();
    const approveDialog = page.getByRole("dialog", { name: /Approve plan version 1/ });
    await expect(approveDialog).toBeVisible();
    // Every confirmation checkbox begins unchecked — never pre-authorized.
    await expect(approveDialog.getByRole("checkbox")).not.toBeChecked();
    // Escape closes without mutating, and focus returns to the trigger
    // that opened it — not lost to <body>.
    await page.keyboard.press("Escape");
    await expect(approveDialog).not.toBeVisible();
    await expect(approveTrigger).toBeFocused();

    await approveTrigger.click();
    await expect(approveDialog).toBeVisible();
    await expect(approveDialog.getByRole("checkbox")).not.toBeChecked();
    await approveDialog.getByRole("checkbox").check();
    await approveDialog.getByRole("button", { name: "Approve plan" }).click();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Delegate…" }).click();
    const delegateDialog = page.getByRole("dialog");
    await expect(delegateDialog.getByRole("checkbox")).not.toBeChecked();
    await delegateDialog.getByRole("checkbox").check();
    const planUrl = page.url();
    await delegateDialog.getByRole("button", { name: "Delegate" }).click();
    await expect(delegateDialog.getByText(/Delegated — 3 child tasks created/)).toBeVisible();
    await page.keyboard.press("Escape");

    async function assignAgent(cardTitle: string, agentLabel: string): Promise<void> {
      const targetCard = cardFor(page, cardTitle);
      await openActionsMenu(targetCard);
      await page.getByRole("button", { name: "Return to Ready" }).click();
      await expect(targetCard.getByText("Ready", { exact: true })).toBeVisible();
      await openActionsMenu(targetCard);
      await page.getByRole("button", { name: "Assign agent" }).click();
      const dialog = page.getByRole("dialog", { name: "Assign an agent" });
      await dialog.getByLabel("Agent").selectOption({ label: agentLabel });
      await dialog.getByRole("button", { name: "Assign", exact: true }).click();
      await expect(dialog).not.toBeVisible();
    }
    await page.goto("/board");
    await assignAgent(`Investigate: ${title}`, "CEO Execution Fixture (permanent failure)");
    await assignAgent(`Implement: ${title}`, "CEO Execution Fixture (success)");
    await assignAgent(`Verify: ${title}`, "CEO Execution Fixture (success)");
    await page.goto(planUrl);

    await page.getByRole("button", { name: "Configure execution…" }).click();
    const configureDialog = page.getByRole("dialog", { name: "Configure execution" });
    await configureDialog
      .getByRole("radio", { name: /Autonomous — the scheduler starts eligible steps/ })
      .check();
    await configureDialog
      .getByRole("checkbox", {
        name: "Pause the whole run for review on any permanent step failure",
      })
      .uncheck();
    await configureDialog.getByRole("button", { name: "Configure", exact: true }).click();
    await expect(configureDialog).not.toBeVisible();

    const startTrigger = page.getByRole("button", { name: "Start execution…" });
    await startTrigger.click();
    const startDialog = page.getByRole("dialog", { name: /Start execution — plan version 1/ });
    const authorizeCheckbox = startDialog.getByRole("checkbox", {
      name: "I authorize Hall to automatically start eligible child tasks under this execution policy.",
    });
    await expect(authorizeCheckbox).not.toBeChecked();
    await authorizeCheckbox.check();
    await startDialog.getByRole("button", { name: "Start execution", exact: true }).click();
    await expect(startDialog).not.toBeVisible();

    // Status is never color-only — the step's own status renders as a
    // distinct, readable text label, and stays that way through to
    // "Failed" (this task's fixture always fails permanently).
    const investigateStatus = page
      .getByRole("region", { name: "Autonomous execution" })
      .getByText(/^Step 1: Investigate:/)
      .locator("..");
    await expect(investigateStatus.getByText("Failed", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByText("Awaiting intervention", { exact: true }).first()).toBeVisible();

    // A keyboard-only path to the failed step's own retry action (Tab
    // reaches it and Enter activates it, with no mouse interaction at
    // all) — scoped to the Investigate row specifically, since the
    // blocked-by-failed-dependency Implement step also renders its own
    // "Retry step" button (`RETRY_ELIGIBLE_STEP_STATUSES` covers both
    // `"failed"` and `"awaiting_intervention"`).
    const retryButton = investigateStatus.locator("..").getByRole("button", { name: "Retry step" });
    await retryButton.focus();
    await expect(retryButton).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(retryButton).toBeVisible({ timeout: 15000 });

    await assertNoHorizontalOverflow(page, 1440);
  });
});
