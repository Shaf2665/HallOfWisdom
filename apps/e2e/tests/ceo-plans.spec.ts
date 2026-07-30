import { expect, type Page, test } from "@playwright/test";

/**
 * Phase 14 E2E — the CEO Agent planning, approval-gated delegation, and
 * plan tracking workflow, against the deterministic fixture Hall Core
 * (`src/fixture-server.ts`, same shared instance `routing-and-assignment.spec.ts`
 * uses). Covers the load-bearing spine explicitly: create a draft plan,
 * submit it, approve it (confirming approval alone starts nothing),
 * delegate it (confirming exactly one unstarted child task per step,
 * correctly linked), and a reject flow.
 *
 * Deliberately NOT covered here (disclosed, not silently skipped — see
 * the Phase 14 end-of-phase report):
 *   - Starting a delegated child task and observing live progress in the
 *     browser. `src/fixture-adapters.ts`'s `startTask()` rejects
 *     unconditionally for every non-comparison adapter, including
 *     "hall.claude-code" (this file's recommended adapter, chosen by
 *     routing and assigning the parent task first — the plain
 *     backlog-creation form has no requirements field, and the
 *     deterministic planner correctly recommends nothing without one) —
 *     an established, repo-wide Phase 11 fixture constraint this suite
 *     already respects everywhere else (see that file's own header
 *     comment, and `routing-and-assignment.spec.ts`'s). The underlying
 *     behavior this would exercise — `refreshProgress()`'s lazy,
 *     write-on-read terminal-status sync, and that a second read is
 *     idempotent — is covered with a REAL executable Mock Agent by
 *     `apps/server/src/composition/ceo-plan-durable-restart.test.ts`.
 *   - Plan editing / "Save new version" (no such UI was built in this
 *     phase — see `CeoPlanDetail`'s own doc comment on `showSubmit`).
 *   - The full 41-step scripted browser scenario and the dedicated
 *     keyboard-only/repeated-click focused tests from the kickoff's test
 *     list — this file exercises the same underlying actions but with a
 *     smaller, hand-picked assertion set.
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

async function openCeoPlansForTask(page: Page, title: string): Promise<void> {
  const card = cardFor(page, title);
  await openActionsMenu(card);
  await page.getByRole("button", { name: "CEO plans" }).click();
  await expect(page).toHaveURL(/\/ceo\?parentTaskId=/);
}

test.describe("CEO Agent planning workflow (Phase 14)", () => {
  test("create -> submit -> approve -> delegate: a draft plan becomes three unstarted, correctly-assigned child tasks, and approval alone starts nothing", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `CEO spine task ${Date.now().toString()}`;
    await createBacklogTask(
      page,
      title,
      "Login redirects to /404 instead of /dashboard after SSO callback.",
    );

    // The plain backlog-creation form has no requirements field — the
    // deterministic CEO planner correctly refuses to recommend an
    // adapter for a task with none set (see `ceo-plan-routing.ts`'s
    // "never fabricate" discipline), which would leave delegation with no
    // eligible adapter to assign. Routing and assigning first (the
    // default "Code implementation — isolated preferred" profile, exactly
    // as `routing-and-assignment.spec.ts` uses) is the only way to give
    // the parent task real, persisted `requirements` through genuine UI
    // navigation.
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

    await openCeoPlansForTask(page, title);
    await expect(page.getByText("No CEO plans yet for this task.")).toBeVisible();

    // Opening the dialog creates nothing by itself.
    await page.getByRole("button", { name: "Ask CEO to plan" }).click();
    const createDialog = page.getByRole("dialog", { name: "Ask CEO to plan" });
    await expect(createDialog).toBeVisible();
    await createDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(createDialog).not.toBeVisible();
    await expect(page.getByText("No CEO plans yet for this task.")).toBeVisible();

    await page.getByRole("button", { name: "Ask CEO to plan" }).click();
    await expect(page.getByRole("dialog", { name: "Ask CEO to plan" })).toBeVisible();
    await page.getByRole("button", { name: "Create draft plan" }).click();

    // Navigated to the new plan's own detail page.
    await expect(page).toHaveURL(/\/ceo\/[^/?]+$/);
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await expect(page.getByText("Steps (3)")).toBeVisible();
    await expect(page.getByText(/^Step 1: Investigate:/)).toBeVisible();
    await expect(page.getByText(/^Step 2: Implement:/)).toBeVisible();
    await expect(page.getByText(/^Step 3: Verify:/)).toBeVisible();
    await expect(page.getByText("Depends on 1 earlier step")).toHaveCount(2);

    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText("Awaiting approval", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit for approval" })).not.toBeVisible();

    // Approval dialog: no pre-checked confirmation, button disabled until
    // ticked, shows every step's selected agent.
    await page.getByRole("button", { name: "Approve…" }).click();
    const approveDialog = page.getByRole("dialog", { name: /Approve plan version 1/ });
    await expect(approveDialog).toBeVisible();
    await expect(approveDialog.getByText("hall.claude-code (isolated)")).toHaveCount(3);
    const confirmApprove = approveDialog.getByRole("checkbox");
    await expect(confirmApprove).not.toBeChecked();
    const approveButton = approveDialog.getByRole("button", { name: "Approve plan" });
    await expect(approveButton).toBeDisabled();
    await confirmApprove.check();
    await expect(approveButton).toBeEnabled();
    await approveButton.click();
    await expect(approveDialog).not.toBeVisible();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();

    // Approval alone starts nothing — no new cards on the board.
    await page.goto("/board");
    await expect(cardFor(page, `Investigate: ${title}`)).toHaveCount(0);
    await page.goBack();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();

    // Delegation dialog: same disabled-until-confirmed discipline. Not
    // scoped by accessible name — the dialog's own heading (and so its
    // `aria-labelledby` name) changes from "Delegate plan version 1" to
    // "Delegated — N child tasks created" once delegation succeeds, and
    // only one dialog is ever open at a time.
    await page.getByRole("button", { name: "Delegate…" }).click();
    const delegateDialog = page.getByRole("dialog");
    await expect(delegateDialog).toBeVisible();
    const delegateButton = delegateDialog.getByRole("button", { name: "Delegate" });
    await expect(delegateButton).toBeDisabled();
    await delegateDialog.getByRole("checkbox").check();
    await expect(delegateButton).toBeEnabled();
    await delegateButton.click();
    await expect(delegateDialog.getByText(/Delegated — 3 child tasks created/)).toBeVisible();
    // Never a bulk "Start All" control.
    await expect(delegateDialog.getByRole("button", { name: /Start all/i })).toHaveCount(0);

    await delegateDialog.getByRole("link", { name: "Go to Kanban board" }).click();
    await expect(page).toHaveURL(/\/board$/);

    const investigateCard = cardFor(page, `Investigate: ${title}`);
    const implementCard = cardFor(page, `Implement: ${title}`);
    const verifyCard = cardFor(page, `Verify: ${title}`);
    await expect(investigateCard).toContainText("Assigned");
    await expect(implementCard).toContainText("Assigned");
    await expect(verifyCard).toContainText("Assigned");
    // Assigned, not launching — every delegated child is left unstarted.
    await expect(investigateCard.getByText("Starting…")).not.toBeVisible();
    await expect(implementCard.getByText("Starting…")).not.toBeVisible();
    await expect(verifyCard.getByText("Starting…")).not.toBeVisible();

    // Every delegated child still exposes a manual "Start task" action —
    // delegation never removes the existing, always-explicit start path.
    await expect(investigateCard.getByRole("button", { name: "Start task" })).toBeVisible();
  });

  test("reject a submitted plan: recorded in approval history, and the plan offers no direct re-submit", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `CEO reject task ${Date.now().toString()}`;
    await createBacklogTask(page, title, "Add a retry button to the failed-upload banner.");

    await openCeoPlansForTask(page, title);
    await page.getByRole("button", { name: "Ask CEO to plan" }).click();
    await page.getByRole("button", { name: "Create draft plan" }).click();
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Submit for approval" }).click();
    await expect(page.getByText("Awaiting approval", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Reject…" }).click();
    const rejectDialog = page.getByRole("dialog", { name: /Reject plan version 1/ });
    await expect(rejectDialog).toBeVisible();
    await rejectDialog.getByLabel(/Reason/).fill("Needs a rollback step first.");
    await rejectDialog.getByRole("button", { name: "Reject plan" }).click();
    await expect(rejectDialog).not.toBeVisible();

    await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
    await expect(page.getByText(/Version 1 — reject/)).toBeVisible();
    await expect(page.getByText(/Needs a rollback step first\./)).toBeVisible();

    // A rejected plan currently offers no direct re-submit in this UI
    // (see `CeoPlanDetail`'s doc comment) — only cancellation remains.
    await expect(page.getByRole("button", { name: "Submit for approval" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Approve…" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel plan" })).toBeVisible();
  });
});
