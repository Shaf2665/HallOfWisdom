import { expect, type Page, test } from "@playwright/test";

/**
 * Phase 14.1 — five focused CEO plan tests against the shared fixture Hall
 * Core (`src/fixture-server.ts`, the same instance `ceo-plans.spec.ts` and
 * `routing-and-assignment.spec.ts` use), each exercising one specific,
 * narrow behavior the spine test in `ceo-plans.spec.ts` doesn't cover:
 *
 *   (A) reject → edit → resubmit → approve — the full round trip through
 *       the Phase 14.1 editor, proving a rejected plan can be revised back
 *       into an approvable draft.
 *   (B) keyboard-only interaction — every CEO dialog closes on Escape
 *       without mutating anything, restores focus to its trigger, and
 *       every confirmation checkbox starts unchecked.
 *   (C) duplicate delegation — firing the delegate action twice in quick
 *       succession never creates more than one set of child tasks, run
 *       five consecutive times against five independent plans.
 *   (D) a 390×844 mobile viewport never produces horizontal scroll across
 *       the create/edit/adapter-selector flow.
 *   (E) a 1440×900 desktop pass produces zero console errors, page
 *       errors, or failed (CORS-shaped) network requests across the full
 *       create→edit→submit→approve→delegate flow.
 *
 * All five use the registered Mock Agent adapter's "Simulation / testing"
 * profile only where a step needs real, persisted `requirements` for the
 * adapter selector to render candidates (D); none of these tests ever
 * starts a delegated child task — that real-adapter-completion path is
 * `ceo-plans-durable-restart.spec.ts`'s job, not this file's.
 */

async function createBacklogTask(page: Page, title: string, description: string): Promise<void> {
  await page.getByRole("button", { name: "+ New backlog task" }).click();
  await page.getByLabel("Project").fill("e2e-project");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Description").fill(description);
  await page.getByRole("button", { name: "Add to Backlog" }).click();
  await expect(page.getByRole("button", { name: `Drag ${title}`, exact: false })).toBeVisible();
}

function cardFor(page: Page, title: string) {
  return page.locator("li", { has: page.getByText(title, { exact: true }) });
}

/**
 * `MoveMenu` (`move-menu.tsx`, Phase 14.2) flips above the trigger when
 * there isn't room below and clamps to the viewport on both axes, so its
 * popover is always pointer-reachable regardless of how far down a
 * column the trigger sits or how narrow the viewport is — no scrolling,
 * retrying, or bypassing Playwright's actionability checks required.
 * Every interaction here goes through ordinary `locator.click()`.
 */
async function performMenuAction(page: Page, title: string, itemName: string): Promise<void> {
  const card = cardFor(page, title);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("button", { name: itemName }).click();
}

async function openCeoPlansForTask(page: Page, title: string): Promise<void> {
  await performMenuAction(page, title, "CEO plans");
  await expect(page).toHaveURL(/\/ceo\?parentTaskId=/);
}

/** Routes and assigns via the default "Code implementation — isolated preferred" profile, recommending Claude Code — matches `ceo-plans.spec.ts`'s own convention. Never started in this file. */
async function routeAndAssignDefault(page: Page, title: string): Promise<void> {
  const card = cardFor(page, title);
  await performMenuAction(page, title, "Move to Ready");
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  await performMenuAction(page, title, "Find suitable agent");
  const routingDialog = page.getByRole("dialog", { name: /Find suitable agent/ });
  await expect(routingDialog.getByText(/Recommended "Claude Code"/)).toBeVisible();
  await routingDialog.getByRole("button", { name: "Route and assign" }).click();
  await expect(card.getByText("Assigned", { exact: true })).toBeVisible();
}

/** Routes and assigns via "Simulation / testing" (Mock Agent), the only profile whose adapter selector has an eligible candidate. */
async function routeAndAssignSimulation(page: Page, title: string): Promise<void> {
  const card = cardFor(page, title);
  await performMenuAction(page, title, "Move to Ready");
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  await performMenuAction(page, title, "Find suitable agent");
  const routingDialog = page.getByRole("dialog", { name: /Find suitable agent/ });
  await routingDialog
    .getByLabel("Requirement profile")
    .selectOption({ label: "Simulation / testing" });
  await expect(routingDialog.getByText(/Recommended "Mock Agent"/)).toBeVisible();
  await routingDialog.getByRole("button", { name: "Route and assign" }).click();
  await expect(card.getByText("Assigned", { exact: true })).toBeVisible();
}

test.describe("CEO plans focused tests (Phase 14.1)", () => {
  test("(A) reject an approved-for-review plan, edit it into a new draft, resubmit, and approve", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `CEO focused A ${Date.now().toString()}`;
    await createBacklogTask(page, title, "Add a rate limiter to the public search endpoint.");
    await routeAndAssignDefault(page, title);

    await openCeoPlansForTask(page, title);
    await page.getByRole("button", { name: "Ask CEO to plan" }).click();
    await page.getByRole("button", { name: "Create draft plan" }).click();
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText("Awaiting approval", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Reject…" }).click();
    const rejectDialog = page.getByRole("dialog", { name: /Reject plan version 1/ });
    await rejectDialog.getByLabel(/Reason/).fill("Add rollback steps first.");
    await rejectDialog.getByRole("button", { name: "Reject plan" }).click();
    await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit for approval" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Approve…" })).not.toBeVisible();

    // Edit the rejected plan into a new draft version — the only forward
    // path back to submittable, per `CeoPlanDetail`'s own doc comment.
    await page.getByRole("button", { name: "Edit plan…" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit plan — save as new version" });
    const objective = editDialog.locator("#ceo-plan-edit-objective");
    const originalObjective = await objective.inputValue();
    await objective.fill(`${originalObjective} (revised after rejection)`);
    await editDialog.getByRole("button", { name: "Save as new version" }).click();
    await expect(editDialog).not.toBeVisible();
    await expect(page.getByText("New plan version saved.")).toBeVisible();
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await expect(
      page.locator("dt", { hasText: "Active version" }).locator("..").locator("dd"),
    ).toHaveText("2");
    await expect(page.getByText(`${originalObjective} (revised after rejection)`)).toBeVisible();

    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText("Awaiting approval", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Approve…" }).click();
    const approveDialog = page.getByRole("dialog", { name: /Approve plan version 2/ });
    await approveDialog.getByRole("checkbox").check();
    await approveDialog.getByRole("button", { name: "Approve plan" }).click();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();

    await expect(page.getByText(/Version 1 — reject/)).toBeVisible();
    await expect(page.getByText(/Version 2 — approve/)).toBeVisible();
  });

  test("(B) every CEO dialog closes on Escape without mutating anything, restores focus, and every confirmation checkbox starts unchecked", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `CEO focused B ${Date.now().toString()}`;
    await createBacklogTask(page, title, "Add pagination to the audit log viewer.");
    await routeAndAssignDefault(page, title);

    await openCeoPlansForTask(page, title);

    // --- Create dialog: Escape closes without creating a plan ---
    const askButton = page.getByRole("button", { name: "Ask CEO to plan" });
    await askButton.click();
    await expect(page.getByRole("dialog", { name: "Ask CEO to plan" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(askButton).toBeFocused();
    await expect(page.getByText("No CEO plans yet for this task.")).toBeVisible();

    // Now actually create one, to exercise the remaining dialogs.
    await askButton.click();
    await page.getByRole("button", { name: "Create draft plan" }).click();
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText("Awaiting approval", { exact: true })).toBeVisible();

    // --- Approve dialog: unchecked by default; Escape closes without approving ---
    const approveButton = page.getByRole("button", { name: "Approve…" });
    await approveButton.click();
    const approveDialog = page.getByRole("dialog", { name: /Approve plan version 1/ });
    await expect(approveDialog.getByRole("checkbox")).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(approveButton).toBeFocused();
    await expect(page.getByText("Awaiting approval", { exact: true })).toBeVisible();

    // --- Reject dialog: Escape closes without rejecting ---
    const rejectButton = page.getByRole("button", { name: "Reject…" });
    await rejectButton.click();
    await expect(page.getByRole("dialog", { name: /Reject plan version 1/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(rejectButton).toBeFocused();
    await expect(page.getByText("Awaiting approval", { exact: true })).toBeVisible();

    // Actually approve, to reach the delegate/edit dialogs.
    await approveButton.click();
    await approveDialog.getByRole("checkbox").check();
    await approveDialog.getByRole("button", { name: "Approve plan" }).click();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();

    // --- Delegate dialog: unchecked by default; Escape closes without delegating ---
    const delegateButton = page.getByRole("button", { name: "Delegate…" });
    await delegateButton.click();
    const delegateDialog = page.getByRole("dialog");
    await expect(delegateDialog.getByRole("checkbox")).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(delegateButton).toBeFocused();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    await page.goto("/board");
    await expect(cardFor(page, `Investigate: ${title}`)).toHaveCount(0);
    await page.goBack();

    // --- Edit dialog: Escape closes without saving a new version ---
    const editButton = page.getByRole("button", { name: "Edit plan…" });
    await editButton.click();
    await expect(
      page.getByRole("dialog", { name: "Edit plan — save as new version" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(editButton).toBeFocused();
    await expect(
      page.locator("dt", { hasText: "Active version" }).locator("..").locator("dd"),
    ).toHaveText("1");
  });

  test("(C) firing delegate twice in quick succession never creates more than one set of child tasks — five consecutive plans", async ({
    page,
  }) => {
    // Five full rounds, each creating a parent plus three delegated
    // children on the shared, accumulating fixture board — genuinely
    // exceeds Playwright's default 30s per-test budget by the later
    // rounds, matching `ceo-plans-durable-restart.spec.ts`'s own
    // `test.setTimeout` convention for its similarly multi-step scenario.
    test.setTimeout(120_000);
    for (let round = 1; round <= 5; round += 1) {
      await page.goto("/board");
      const title = `CEO focused C round ${String(round)} ${Date.now().toString()}`;
      await createBacklogTask(page, title, "Add a CSV export button to the reports page.");
      await routeAndAssignDefault(page, title);

      await openCeoPlansForTask(page, title);
      await page.getByRole("button", { name: "Ask CEO to plan" }).click();
      await page.getByRole("button", { name: "Create draft plan" }).click();
      await expect(page).toHaveURL(/\/ceo\/[^/?]+$/);
      const planUrl = page.url();
      await page.getByRole("button", { name: "Submit for approval" }).click();
      await page.getByRole("button", { name: "Approve…" }).click();
      const approveDialog = page.getByRole("dialog", { name: /Approve plan version 1/ });
      await approveDialog.getByRole("checkbox").check();
      await approveDialog.getByRole("button", { name: "Approve plan" }).click();
      await expect(page.getByText("Approved", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Delegate…" }).click();
      const delegateDialog = page.getByRole("dialog");
      await delegateDialog.getByRole("checkbox").check();
      const delegateButton = delegateDialog.getByRole("button", { name: "Delegate" });
      // Two native click events dispatched back-to-back in the same
      // browser task, before React can re-render the button as disabled —
      // the closest a black-box UI test can come to genuinely racing the
      // handler twice, rather than relying on Playwright's own
      // actionability checks (which would just wait out the disabled
      // state on a second `.click()` and never actually race anything).
      await delegateButton.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await expect(delegateDialog.getByText(/Delegated — 3 child tasks created/)).toBeVisible();
      await delegateDialog.getByRole("link", { name: "Go to Kanban board" }).click();
      await expect(page).toHaveURL(/\/board$/);

      await expect(cardFor(page, `Investigate: ${title}`)).toHaveCount(1);
      await expect(cardFor(page, `Implement: ${title}`)).toHaveCount(1);
      await expect(cardFor(page, `Verify: ${title}`)).toHaveCount(1);

      await performMenuAction(page, title, "Open discussion");
      await expect(
        page.getByText(/CEO plan .+ delegated: 3 child task\(s\) created\./),
      ).toBeVisible();
      const delegationMessages = await page
        .getByText(/CEO plan .+ delegated: 3 child task\(s\) created\./)
        .count();
      expect(delegationMessages).toBe(1);

      // Exactly one `ceo.plan.delegated` event in the plan's own Activity
      // log, too — the audit message and the plan event are two separate
      // records the same double-click could have duplicated independently.
      await page.goto(planUrl);
      await expect(page.getByText("ceo.plan.delegated")).toHaveCount(1);
    }
  });

  test("(D) mobile 390×844 — the create/edit/adapter-selector flow never produces horizontal scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    async function assertNoHorizontalOverflow(): Promise<void> {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
    }

    // Mostly scoped to the CEO-specific screens this test exists to
    // cover, but `/board` itself is checked too right after navigating
    // there — its columns row no longer leaks past the document's own
    // width at mobile widths (Phase 14.3 fix: `position: relative` on the
    // columns row in `kanban-board.tsx`, containing an `sr-only` label's
    // absolutely-positioned static offset).
    await page.goto("/board");
    await assertNoHorizontalOverflow();
    const title = `CEO focused D ${Date.now().toString()}`;
    await createBacklogTask(page, title, "Add dark-mode support to the settings page.");
    await routeAndAssignSimulation(page, title);

    await openCeoPlansForTask(page, title);
    await assertNoHorizontalOverflow();
    await page.getByRole("button", { name: "Ask CEO to plan" }).click();
    await assertNoHorizontalOverflow();
    await page.getByRole("button", { name: "Create draft plan" }).click();
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow();

    await page.getByRole("button", { name: "Edit plan…" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit plan — save as new version" });
    await expect(editDialog).toBeVisible();
    await assertNoHorizontalOverflow();
    // The per-step adapter selector's "Recommended" candidate line is the
    // widest content this dialog renders for a Mock Agent step — Mock
    // Agent's `executionTrust` is always `simulated` (see `descriptor.ts`),
    // so its own trusted-local warning never appears here; that text is
    // exercised at normal viewport width by `ceo-step-adapter-selector.test.tsx`
    // instead, not by this mobile-viewport check. Confirm the selector
    // itself is visible and reachable, not merely present in the DOM
    // off-screen.
    await expect(editDialog.getByText("Mock Agent (hall.mock-agent)").first()).toBeVisible();
    await assertNoHorizontalOverflow();
    await editDialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("(E) desktop 1440×900 — zero console errors, page errors, or failed requests across the full create→edit→submit→approve→delegate flow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/webpack-hmr|Fast Refresh/i.test(text)) return;
      consoleIssues.push(text);
    });
    page.on("pageerror", (error) => {
      consoleIssues.push(`pageerror: ${error.message}`);
    });
    const failedRequests: string[] = [];
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "unknown error";
      // `net::ERR_ABORTED` is the expected, benign signature of an
      // in-flight fetch cancelled by its own `AbortController` on
      // unmount/navigation (e.g. `CeoStepAdapterSelector`'s routing-analysis
      // fetch) — a real network or CORS failure surfaces as a different
      // error code (`ERR_FAILED`, `ERR_CONNECTION_REFUSED`, etc.), which
      // this still catches.
      if (errorText === "net::ERR_ABORTED") return;
      failedRequests.push(`${request.method()} ${request.url()}: ${errorText}`);
    });

    await page.goto("/board");
    const title = `CEO focused E ${Date.now().toString()}`;
    await createBacklogTask(page, title, "Add a health-check page for on-call engineers.");
    await routeAndAssignSimulation(page, title);

    await openCeoPlansForTask(page, title);
    await page.getByRole("button", { name: "Ask CEO to plan" }).click();
    await page.getByRole("button", { name: "Create draft plan" }).click();
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Edit plan…" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit plan — save as new version" });
    await expect(editDialog.getByText("Mock Agent (hall.mock-agent)").first()).toBeVisible();
    await editDialog.getByRole("button", { name: "Save as new version" }).click();
    await expect(editDialog).not.toBeVisible();

    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText("Awaiting approval", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Approve…" }).click();
    const approveDialog = page.getByRole("dialog", { name: /Approve plan version 2/ });
    await approveDialog.getByRole("checkbox").check();
    await approveDialog.getByRole("button", { name: "Approve plan" }).click();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Delegate…" }).click();
    const delegateDialog = page.getByRole("dialog");
    await delegateDialog.getByRole("checkbox").check();
    await delegateDialog.getByRole("button", { name: "Delegate" }).click();
    await expect(delegateDialog.getByText(/Delegated — 3 child tasks created/)).toBeVisible();
    await delegateDialog.getByRole("link", { name: "Go to Kanban board" }).click();
    await expect(page).toHaveURL(/\/board$/);

    expect(consoleIssues).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});
