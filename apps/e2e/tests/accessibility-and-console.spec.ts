import { expect, test } from "@playwright/test";

/**
 * Phase 11.1 E2E — keyboard-only operation of the routing dialog, and a
 * clean-console assertion across the Agents/Kanban pages. Console
 * collection is wired per-test (not globally) so a failure clearly
 * attributes to the page under test.
 */

test.describe("Keyboard-only operation", () => {
  test("Find suitable agent opens via keyboard, Escape closes without mutation, focus returns to Actions", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `Keyboard task ${Date.now().toString()}`;

    await page.getByRole("button", { name: "+ New backlog task" }).click();
    await page.getByLabel("Project").fill("e2e-project");
    await page.getByLabel("Title").fill(title);
    await page.getByRole("button", { name: "Add to Backlog" }).click();

    const card = page.locator("li", { has: page.getByText(title, { exact: true }) });
    const actionsButton = card.getByRole("button", { name: "Actions" });
    await actionsButton.click();
    await page.getByRole("button", { name: "Move to Ready" }).click();
    await expect(card.getByText("Ready")).toBeVisible();

    // Open Actions via keyboard, navigate to "Find suitable agent", open
    // with Enter.
    await actionsButton.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Find suitable agent" }).focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: /Find suitable agent/ });
    await expect(dialog).toBeVisible();

    // 39. Focus enters the dialog — the browser's active element is
    // somewhere inside it, not still on the page body.
    const focusInsideDialog = await page.evaluate(() => {
      const active = document.activeElement;
      const dialogEl = document.querySelector('[role="dialog"]');
      return dialogEl?.contains(active) ?? false;
    });
    expect(focusInsideDialog).toBe(true);

    // 40. Escape closes without mutation.
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(card.getByText("Ready")).toBeVisible();

    // 41. Focus returns to the Actions control.
    await expect(actionsButton).toBeFocused();

    // 42. Route-and-assign requires an explicit action — opening and
    // closing the dialog via keyboard alone (above) never assigned
    // anything, already confirmed by the card still reading "Ready".
  });
});

test.describe("Console cleanliness", () => {
  test("no uncaught errors, hydration warnings, or CORS failures on /agents", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await page.goto("/agents");
    await expect(page.getByRole("table")).toBeVisible();

    expect(pageErrors).toEqual([]);
    const seriousErrors = consoleErrors.filter(
      (text) => !/favicon/i.test(text) && !/DevTools/i.test(text),
    );
    expect(seriousErrors).toEqual([]);
    expect(consoleErrors.some((text) => /hydration/i.test(text))).toBe(false);
    expect(consoleErrors.some((text) => /cors|cross-origin/i.test(text))).toBe(false);
    // Never a raw adapter diagnostic leaking into the console.
    expect(consoleErrors.some((text) => /executablePath|CODEX_HOME/i.test(text))).toBe(false);
  });

  test("no uncaught errors, hydration warnings, or CORS failures on /board", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });

    await page.goto("/board");
    await expect(page.getByRole("button", { name: "+ New backlog task" })).toBeVisible();

    expect(pageErrors).toEqual([]);
    const seriousErrors = consoleErrors.filter(
      (text) => !/favicon/i.test(text) && !/DevTools/i.test(text),
    );
    expect(seriousErrors).toEqual([]);
    expect(consoleErrors.some((text) => /hydration/i.test(text))).toBe(false);
    expect(consoleErrors.some((text) => /cors|cross-origin/i.test(text))).toBe(false);
  });
});
