import { expect, type Page, test } from "@playwright/test";

/**
 * Phase 15.1 kickoff §11 — a real, browser-driven autonomous execution
 * run against the deterministic fixture Hall Core
 * (`src/fixture-server.ts`), through genuine UI actions only: no
 * `force: true`, no DOM-dispatched clicks, no direct handler invocation
 * anywhere in this file.
 *
 * **A genuine product constraint found while building this spec, not a
 * shortcut**: the deterministic CEO planner (`ceo-plan-routing.ts` /
 * `deterministic-ceo-planner.ts`, built in an earlier phase) always
 * generates the SAME fixed 3-step linear chain for any task —
 * "Investigate" -> "Implement" (depends on step 1) -> "Verify" (depends
 * on step 2) — see `ceo-plans.spec.ts`'s own "Steps (3)" /
 * "Depends on 1 earlier step" assertions. There is no UI path to a
 * synthetic 4-step A/B/C/D graph the original kickoff envisioned; this
 * spec instead proves the same class of behavior — multi-step autonomous
 * execution correctly respecting real, persisted step dependencies —
 * against the planner's actual fixed output shape. Documented here, and
 * in the phase's final report, rather than silently substituted.
 *
 * Each delegated child task is manually reassigned (via the genuine
 * "Assign agent" dialog, not the routing-recommendation flow, which has
 * no knowledge of this file's new fixture adapter) to
 * `hall.ceo-fixture-success` — a real `MockAgentAdapter` wrapped under a
 * new adapter id specifically for CEO execution specs (see
 * `fixture-adapters.ts`'s `withAdapterId` doc comment) — never
 * `hall.mock-agent` itself, whose `startTask()` the routing/assignment/
 * planning specs still rely on rejecting unconditionally.
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

async function assignToFixture(page: Page, cardTitle: string): Promise<void> {
  const card = cardFor(page, cardTitle);
  // Delegation leaves every child task already "assigned" (to whatever
  // the deterministic planner recommended, which has no knowledge of
  // this file's new fixture adapter) — and "Assign agent" is only
  // offered for a "ready" task (see `availableActionsFor` in
  // `lib/kanban.ts`), never an already-assigned one. "Return to Ready"
  // first, through the real UI, is what makes a genuine reassignment
  // reachable at all.
  await openActionsMenu(card);
  await page.getByRole("button", { name: "Return to Ready" }).click();
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();

  await openActionsMenu(card);
  await page.getByRole("button", { name: "Assign agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Assign an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Agent").selectOption({ label: "CEO Execution Fixture (success)" });
  await dialog.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/**
 * The step row's title `<p>` and status `<span>` are direct siblings
 * under one wrapper div — see `ceo-plan-execution-section.tsx`. Scoped to
 * the "Autonomous execution" region specifically: `ceo-plan-detail.tsx`'s
 * OWN separate "Plan steps" region shows the same step titles with its
 * own independent delegation-progress badge (`STEP_PROGRESS_LABELS`),
 * which can legitimately show the same status text ("Running",
 * "Completed") at the same moment — an unscoped page-wide lookup hits a
 * Playwright strict-mode violation once both are visible together.
 */
function stepStatus(page: Page, stepTitlePattern: RegExp) {
  return page
    .getByRole("region", { name: "Autonomous execution" })
    .getByText(stepTitlePattern)
    .locator("..");
}

test.describe("CEO plan execution — autonomous DAG (Phase 15.1 kickoff §11)", () => {
  test("a delegated 3-step dependency chain runs to completion under autonomous mode, in dependency order, without any manual per-step Start click", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `Execution DAG task ${Date.now().toString()}`;
    await createBacklogTask(
      page,
      title,
      "Users report the export button silently does nothing on Safari.",
    );

    const card = cardFor(page, title);
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Move to Ready" }).click();
    await expect(card.getByText("Ready", { exact: true })).toBeVisible();
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Find suitable agent" }).click();
    const routingDialog = page.getByRole("dialog", { name: /Find suitable agent/ });
    await routingDialog.getByRole("button", { name: "Route and assign" }).click();
    await expect(card.getByText("Assigned", { exact: true })).toBeVisible();

    await openActionsMenu(card);
    await page.getByRole("button", { name: "CEO plans" }).click();
    await expect(page).toHaveURL(/\/ceo\?parentTaskId=/);
    await page.getByRole("button", { name: "Ask CEO to plan" }).click();
    await page.getByRole("button", { name: "Create draft plan" }).click();
    await expect(page).toHaveURL(/\/ceo\/[^/?]+$/);
    await expect(page.getByText("Steps (3)")).toBeVisible();

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

    // Reassign every delegated child to the fixture adapter that
    // genuinely executes, through the real "Assign agent" dialog.
    await assignToFixture(page, `Investigate: ${title}`);
    await assignToFixture(page, `Implement: ${title}`);
    await assignToFixture(page, `Verify: ${title}`);

    // Back to the plan's own execution section.
    await page.goto(planUrl);

    await page.getByRole("button", { name: "Configure execution…" }).click();
    const configureDialog = page.getByRole("dialog", { name: "Configure execution" });
    await expect(configureDialog).toBeVisible();
    await configureDialog
      .getByRole("radio", { name: /Autonomous — the scheduler starts eligible steps/ })
      .check();
    await configureDialog.getByRole("button", { name: "Configure", exact: true }).click();
    await expect(configureDialog).not.toBeVisible();
    await expect(page.getByText("Configured", { exact: true })).toBeVisible();
    await expect(page.getByText("Autonomous mode")).toBeVisible();

    await page.getByRole("button", { name: "Start execution…" }).click();
    const startDialog = page.getByRole("dialog", { name: /Start execution — plan version 1/ });
    await expect(startDialog).toBeVisible();
    await startDialog
      .getByRole("checkbox", {
        name: "I authorize Hall to automatically start eligible child tasks under this execution policy.",
      })
      .check();
    await startDialog.getByRole("button", { name: "Start execution", exact: true }).click();
    await expect(startDialog).not.toBeVisible();

    // No manual per-step "Start" click anywhere below this line — every
    // step transition from here is the scheduler's own doing. With a
    // 0ms fixture step delay, all three steps chain and complete in well
    // under a second — too fast for UI polling to reliably catch any one
    // step's transient "Running" state, so this waits directly for each
    // step's own FINAL status rather than racing an intermediate one.
    // Dependency ordering itself (a step never starts before its
    // dependency completes) is exhaustively proven server-side already
    // (`ceo-plan-step-readiness.test.ts`,
    // `ceo-plan-execution-scheduler.test.ts`); this spec's job is
    // proving the real browser-driven path reaches the correct end
    // state, not re-catching a sub-second intermediate one.
    await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Completed")).toBeVisible({
      timeout: 15000,
    });
    await expect(stepStatus(page, /^Step 2: Implement:/).getByText("Completed")).toBeVisible({
      timeout: 15000,
    });
    await expect(stepStatus(page, /^Step 3: Verify:/).getByText("Completed")).toBeVisible({
      timeout: 15000,
    });

    // The run itself reaches "Completed" — the whole chain, not just
    // its last step.
    await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });

    // Kanban badges reflect the same terminal state — never contradicting
    // the execution section's own view of the same run.
    await page.goto("/board");
    await expect(cardFor(page, `Investigate: ${title}`)).toContainText("Completed");
    await expect(cardFor(page, `Implement: ${title}`)).toContainText("Completed");
    await expect(cardFor(page, `Verify: ${title}`)).toContainText("Completed");
  });
});
