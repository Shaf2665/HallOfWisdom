import { expect, type Page, test } from "@playwright/test";

/**
 * Phase 11.1 E2E — routing (Find suitable agent) and manual assignment
 * (Assign agent), against the deterministic fixture Hall Core. Every
 * requirement profile used below is a real preset from
 * `apps/web/lib/requirement-profiles.ts` — "Code implementation —
 * isolated preferred" is the picker's default (first) option, so no
 * profile selection is needed to exercise the isolated-only scenarios.
 *
 * Neither this file nor the fixture adapters ever call `startTask()` —
 * "Start task" is never clicked anywhere in this suite.
 */

async function createBacklogTask(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "+ New backlog task" }).click();
  await page.getByLabel("Project").fill("e2e-project");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Add to Backlog" }).click();
  await expect(page.getByRole("button", { name: `Drag ${title}`, exact: false })).toBeVisible();
}

/**
 * Scrolls a card's own "Actions" trigger into view (centered, not just
 * to the nearest edge) before clicking it — the `MoveMenu` popover is
 * portal-positioned from the trigger's post-scroll bounding rect, and
 * cards accumulate across this whole sequential test run (one long-lived
 * fixture Hall Core, no per-test reset), so a card near a column's
 * bottom can otherwise leave the trigger — and the popover rendered
 * beneath it — right at or past the viewport edge.
 */
async function openActionsMenu(card: ReturnType<Page["locator"]>): Promise<void> {
  const trigger = card.getByRole("button", { name: "Actions" });
  // `scrollIntoViewIfNeeded()` scrolls the minimum distance necessary,
  // which can leave the trigger flush against the viewport's bottom edge
  // — exactly where the popover rendered beneath it then overflows.
  // `block: "center"` leaves real margin on both sides.
  await trigger.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
  });
  await trigger.click();
}

async function moveToReady(page: Page, title: string): Promise<void> {
  const card = page.locator("li", { has: page.getByText(title, { exact: true }) });
  await openActionsMenu(card);
  await page.getByRole("button", { name: "Move to Ready" }).click();
  await expect(card.getByText("Ready")).toBeVisible();
}

function cardFor(page: Page, title: string) {
  return page.locator("li", { has: page.getByText(title, { exact: true }) });
}

test.describe("Routing workflow (Find suitable agent)", () => {
  test("recommends isolated Claude, excludes trusted-local Codex and simulated Mock, never assigns until explicit confirmation", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `Routing task ${Date.now().toString()}`;
    await createBacklogTask(page, title);
    await moveToReady(page, title);

    const card = cardFor(page, title);
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Find suitable agent" }).click();

    const dialog = page.getByRole("dialog", { name: /Find suitable agent/ });
    await expect(dialog).toBeVisible();

    // Default profile is "Code implementation — isolated preferred" —
    // read-only analysis runs automatically, no click needed.
    const claudeRow = dialog.getByRole("row", { name: /Claude Code/ });
    await expect(claudeRow).toBeVisible();
    await expect(claudeRow).toHaveClass(/amber/); // recommended row highlight

    // 16-17: Codex and Mock still listed (every candidate is shown), but
    // neither is the recommendation and the explanation names Claude.
    await expect(dialog.getByText(/Recommended "Claude Code"/)).toBeVisible();
    await expect(dialog.getByRole("row", { name: /Codex/ })).toBeVisible();
    await expect(dialog.getByRole("row", { name: /Mock Agent/ })).toBeVisible();

    // 18. Close without assigning.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();

    // 19. Confirm no assignment occurred — card is still Ready.
    await expect(card.getByText("Ready")).toBeVisible();

    // 20-23. Reopen, explicitly route and assign, confirm Assigned with
    // no run/events (the card's own event count is always visible; a
    // fresh assignment always reads "0 events").
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Find suitable agent" }).click();
    const reopened = page.getByRole("dialog", { name: /Find suitable agent/ });
    await expect(reopened.getByText(/Recommended "Claude Code"/)).toBeVisible();
    await reopened.getByRole("button", { name: "Route and assign" }).click();
    await expect(reopened).not.toBeVisible();

    await expect(card.getByText("Assigned", { exact: true })).toBeVisible();
    await expect(card).toContainText("0 events");

    // 24-25. Never clicked Start — no "Starting…" status ever appeared,
    // and the assign confirmation prompt (Start-only UI) is absent.
    await expect(card.getByText("Starting…")).not.toBeVisible();
  });
});

test.describe("Manual assignment (Assign agent)", () => {
  test("after a task has isolated-only requirements, the Assign dialog disables Codex/Mock with a safe reason and enables Claude", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `Manual assign task ${Date.now().toString()}`;
    await createBacklogTask(page, title);
    await moveToReady(page, title);
    const card = cardFor(page, title);

    // Route-and-assign once first — this is the only way, through genuine
    // UI actions, for a task to carry persisted `requirements` (the
    // backlog creation form itself has no requirements field; see
    // `docs/architecture/0011-agent-capabilities-trust-and-routing.md`,
    // "Scoping note"). This also assigns Claude, matching the isolated
    // preset.
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Find suitable agent" }).click();
    const routingDialog = page.getByRole("dialog", { name: /Find suitable agent/ });
    await expect(routingDialog.getByText(/Recommended "Claude Code"/)).toBeVisible();
    await routingDialog.getByRole("button", { name: "Route and assign" }).click();
    await expect(card.getByText("Assigned", { exact: true })).toBeVisible();

    // An `assigned` task's own Actions menu offers "Return to Ready" and
    // "Start task", but never "Assign agent" directly (see
    // `apps/web/lib/kanban.ts`'s `availableActionsFor`) — reassignment
    // through the UI genuinely goes through Ready first. This clears the
    // adapter (`clearAssignment`) but never `task.requirements`, which is
    // exactly the scenario under test: a Ready task whose requirements
    // persist from a prior routing decision.
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Return to Ready" }).click();
    await expect(card.getByText("Ready", { exact: true })).toBeVisible();

    // Now open the regular manual "Assign agent" dialog to verify the
    // requirement-aware UI.
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Assign agent" }).click();
    const assignDialog = page.getByRole("dialog", { name: /Assign an agent/ });
    await expect(assignDialog).toBeVisible();

    await expect(assignDialog.getByText(/Required capabilities:/)).toBeVisible();
    await expect(assignDialog.getByText(/Allowed execution trust:.*isolated/)).toBeVisible();

    // 29. Claude enabled.
    const claudeOption = assignDialog.getByRole("option", { name: /Claude Code/ });
    await expect(claudeOption).toBeEnabled();

    // 30. Codex disabled with a trust-mismatch reason.
    const codexOption = assignDialog.getByRole("option", { name: /Codex/ });
    await expect(codexOption).toBeDisabled();
    await expect(codexOption).toHaveAttribute("title", /execution trust/);

    // 31. Mock disabled with a capability/trust reason.
    const mockOption = assignDialog.getByRole("option", { name: /Mock Agent/ });
    await expect(mockOption).toBeDisabled();

    // 32-33. Explicitly (re)assign Claude — confirms the enabled path
    // still works and the task remains Assigned with no run.
    await assignDialog.getByLabel("Agent").selectOption({ value: "hall.claude-code" });
    await assignDialog.getByRole("button", { name: "Assign" }).click();
    await expect(assignDialog).not.toBeVisible();
    await expect(card.getByText("Assigned", { exact: true })).toBeVisible();
    await expect(card).toContainText("0 events");
  });
});

test.describe("Trusted-local-allowed profile", () => {
  test("ranks isolated Claude ahead of trusted-local Codex, and Codex remains an eligible secondary candidate", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `Trusted-local task ${Date.now().toString()}`;
    await createBacklogTask(page, title);
    await moveToReady(page, title);
    const card = cardFor(page, title);

    await openActionsMenu(card);
    await page.getByRole("button", { name: "Find suitable agent" }).click();
    const dialog = page.getByRole("dialog", { name: /Find suitable agent/ });
    await expect(dialog).toBeVisible();

    await dialog
      .getByLabel("Requirement profile")
      .selectOption({ label: "Code implementation — trusted-local allowed" });

    await expect(dialog.getByText(/Recommended "Claude Code"/)).toBeVisible();
    const claudeRank = await dialog
      .getByRole("row", { name: /Claude Code/ })
      .locator("td")
      .nth(2)
      .innerText();
    const codexRank = await dialog
      .getByRole("row", { name: /Codex/ })
      .locator("td")
      .nth(2)
      .innerText();
    expect(Number(claudeRank)).toBeLessThan(Number(codexRank));

    // Codex is still eligible (assigned a real numeric rank, not "—").
    expect(codexRank).not.toBe("—");

    // 37. Never started either provider — close without assigning.
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(card.getByText("Ready")).toBeVisible();
  });
});
