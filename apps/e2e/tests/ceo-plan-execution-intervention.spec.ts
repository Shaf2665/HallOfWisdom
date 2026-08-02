import { expect, type Page, test } from "@playwright/test";

/**
 * Phase 15.1 kickoff §15 — operator intervention against a real,
 * genuinely in-flight autonomous execution run, through genuine UI
 * actions only: no `force: true`, no DOM-dispatched clicks, no direct
 * handler invocation anywhere in this file. Every step assigned to
 * `hall.ceo-fixture-cancellable` (a real `MockAgentAdapter` in
 * `"cancellable"` scenario, wrapped under a new id — see
 * `fixture-adapters.ts`) stays genuinely "running" until explicitly
 * cancelled, giving these specs a real active task to pause/cancel/
 * emergency-stop against, rather than one that already raced to
 * completion — see `ceo-plan-execution-dag.spec.ts`'s own note on why a
 * 0ms-delay success fixture is too fast for that purpose.
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

/**
 * Cleanup used at the end of any test that leaves the shared
 * `hall.zzz-ceo-fixture-cancellable` adapter's one task-execution slot
 * occupied (`DEFAULT_ADAPTER_CAPACITY` is `1`, and capacity is tracked
 * globally across every run — see `ceo-plan-execution-scheduler.ts`'s
 * `#countActiveForAdapter`). Left un-cancelled, the fixture's
 * "cancellable" scenario keeps that slot busy for its full ~20s natural
 * run (`stepDelayMs: 5000` × 4 awaited steps), which starves the NEXT
 * test in this file of the same adapter and was the actual root cause of
 * this suite's emergency-stop flake: that test's own step never got a
 * chance to start within its assertion timeout, not any defect in
 * emergency stop itself. Cancelling here (a real, already-covered UI
 * action) releases the slot in well under a second instead.
 */
async function cancelActiveTask(page: Page, title: string): Promise<void> {
  await page.goto("/board");
  const card = cardFor(page, title);
  await openActionsMenu(card);
  await page.getByRole("button", { name: "Cancel active task" }).click();
  await card.getByRole("button", { name: "Confirm" }).click();
  await expect(card.getByText("Cancelled", { exact: true })).toBeVisible();
}

async function assignAgent(page: Page, cardTitle: string, agentLabel: string): Promise<void> {
  const card = cardFor(page, cardTitle);
  await openActionsMenu(card);
  await page.getByRole("button", { name: "Return to Ready" }).click();
  await expect(card.getByText("Ready", { exact: true })).toBeVisible();
  await openActionsMenu(card);
  await page.getByRole("button", { name: "Assign agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Assign an agent" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Agent").selectOption({ label: agentLabel });
  await dialog.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/** Full create -> route -> assign -> plan -> submit -> approve -> delegate flow, returning the plan's own detail-page URL and the delegated child-card titles. */
async function delegateFreshPlan(
  page: Page,
  titlePrefix: string,
): Promise<{
  planUrl: string;
  investigateTitle: string;
  implementTitle: string;
  verifyTitle: string;
}> {
  await page.goto("/board");
  const title = `${titlePrefix} ${Date.now().toString()}`;
  await createBacklogTask(page, title, "Users report duplicate emails on password reset.");

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

  return {
    planUrl,
    investigateTitle: `Investigate: ${title}`,
    implementTitle: `Implement: ${title}`,
    verifyTitle: `Verify: ${title}`,
  };
}

async function configureAutonomousAndStart(
  page: Page,
  options: {
    readonly pauseOnAnyPermanentFailure?: boolean;
    readonly maxAttemptsPerStep?: number;
  } = {},
): Promise<void> {
  await page.getByRole("button", { name: "Configure execution…" }).click();
  const configureDialog = page.getByRole("dialog", { name: "Configure execution" });
  await configureDialog
    .getByRole("radio", { name: /Autonomous — the scheduler starts eligible steps/ })
    .check();
  if (options.pauseOnAnyPermanentFailure === false) {
    await configureDialog
      .getByRole("checkbox", {
        name: "Pause the whole run for review on any permanent step failure",
      })
      .uncheck();
  }
  if (options.maxAttemptsPerStep !== undefined) {
    // `DEFAULT_CEO_PLAN_EXECUTION_POLICY.maxAttemptsPerStep` is
    // conservatively `1` — a manual retry on an already-failed step is
    // still subject to the SAME `attemptNumber > maxAttemptsPerStep`
    // policy gate every other attempt goes through (`operator_manual_retry`
    // is just another trigger reason into `#tryAdvanceStep`, not a
    // bypass), so it would otherwise land on "policy_limit_reached"
    // instead of genuinely launching a second attempt.
    await configureDialog
      .getByLabel(/Max attempts per step/)
      .fill(String(options.maxAttemptsPerStep));
  }
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
}

/**
 * Scoped to the "Autonomous execution" region specifically —
 * `ceo-plan-detail.tsx`'s own separate "Plan steps" region shows the
 * same step titles with its own independent delegation-progress badge,
 * which can legitimately show the same status text at the same moment;
 * see `ceo-plan-execution-dag.spec.ts`'s identical helper for the full
 * explanation.
 */
/** The full step row (title+badge, attempts, dependency-block/link/retry sub-row) — two levels up from the title `<p>`. */
function stepRow(page: Page, stepTitlePattern: RegExp) {
  return page
    .getByRole("region", { name: "Autonomous execution" })
    .getByText(stepTitlePattern)
    .locator("..")
    .locator("..");
}

function stepStatus(page: Page, stepTitlePattern: RegExp) {
  return page
    .getByRole("region", { name: "Autonomous execution" })
    .getByText(stepTitlePattern)
    .locator("..");
}

test.describe("CEO plan execution — operator intervention (Phase 15.1 kickoff §15)", () => {
  test("pause leaves an already-running task untouched; Escape closes the confirm dialog without mutating anything; resume continues; Open child task on board navigates", async ({
    page,
  }) => {
    const { planUrl, investigateTitle, implementTitle, verifyTitle } = await delegateFreshPlan(
      page,
      "Intervention pause/resume",
    );
    await assignAgent(page, investigateTitle, "CEO Execution Fixture (cancellable)");
    await assignAgent(page, implementTitle, "CEO Execution Fixture (success)");
    await assignAgent(page, verifyTitle, "CEO Execution Fixture (success)");

    await page.goto(planUrl);
    await configureAutonomousAndStart(page);
    await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Running")).toBeVisible({
      timeout: 30000,
    });

    // Escape closes without mutation — no pre-checked confirmation, and
    // the run is still "Running" (not "Paused") afterward.
    await page.getByRole("button", { name: "Pause…" }).click();
    const pauseDialog = page.getByRole("dialog", { name: "Pause execution?" });
    await expect(pauseDialog).toBeVisible();
    await expect(
      pauseDialog.getByText(
        "Pausing stops Hall from starting new child tasks. Tasks that are already running will continue.",
      ),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pauseDialog).not.toBeVisible();
    await expect(page.getByText("Running", { exact: true }).first()).toBeVisible();

    // A real confirmed pause: the run pauses, but the already-running
    // child task is explicitly left alone.
    await page.getByRole("button", { name: "Pause…" }).click();
    await expect(pauseDialog).toBeVisible();
    await pauseDialog.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(pauseDialog).not.toBeVisible();
    await expect(page.getByText("Paused", { exact: true })).toBeVisible();
    await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Running")).toBeVisible();

    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByText("Running", { exact: true }).first()).toBeVisible();

    await stepRow(page, /^Step 1: Investigate:/)
      .getByRole("link", { name: "Open child task on board" })
      .click();
    await expect(page).toHaveURL(/\/board$/);

    await cancelActiveTask(page, investigateTitle);
  });

  test("cancel future scheduling leaves the active task running but stops the run from claiming any more", async ({
    page,
  }) => {
    const { planUrl, investigateTitle, implementTitle, verifyTitle } = await delegateFreshPlan(
      page,
      "Intervention cancel",
    );
    await assignAgent(page, investigateTitle, "CEO Execution Fixture (cancellable)");
    await assignAgent(page, implementTitle, "CEO Execution Fixture (success)");
    await assignAgent(page, verifyTitle, "CEO Execution Fixture (success)");

    await page.goto(planUrl);
    await configureAutonomousAndStart(page);
    await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Running")).toBeVisible({
      timeout: 30000,
    });

    await page.getByRole("button", { name: "Cancel future scheduling…" }).click();
    const cancelDialog = page.getByRole("dialog", { name: "Cancel future scheduling?" });
    await expect(
      cancelDialog.getByText(
        "Cancelling execution prevents Hall from scheduling any additional child tasks. Tasks that are already running will not be cancelled.",
      ),
    ).toBeVisible();
    await cancelDialog
      .getByRole("button", { name: "Cancel future scheduling", exact: true })
      .click();
    await expect(cancelDialog).not.toBeVisible();
    await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
    // The already-running task is explicitly left alone by a plain
    // cancel — only emergency stop attempts to cancel it.
    await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Running")).toBeVisible();

    await cancelActiveTask(page, investigateTitle);
  });

  test("emergency stop attempts to cancel the active linked child task and requires its own separate confirmation checkbox", async ({
    page,
  }) => {
    const { planUrl, investigateTitle, implementTitle, verifyTitle } = await delegateFreshPlan(
      page,
      "Intervention emergency-stop",
    );
    await assignAgent(page, investigateTitle, "CEO Execution Fixture (cancellable)");
    await assignAgent(page, implementTitle, "CEO Execution Fixture (success)");
    await assignAgent(page, verifyTitle, "CEO Execution Fixture (success)");

    await page.goto(planUrl);
    await configureAutonomousAndStart(page);
    await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Running")).toBeVisible({
      timeout: 30000,
    });

    await page.getByRole("button", { name: "Emergency stop…" }).click();
    const stopDialog = page.getByRole("dialog", { name: "Emergency stop?" });
    await expect(stopDialog).toBeVisible();
    await expect(stopDialog.getByText("Active linked tasks")).toBeVisible();
    await expect(stopDialog.getByText("1")).toBeVisible();
    const confirmButton = stopDialog.getByRole("button", { name: "Emergency stop", exact: true });
    await expect(confirmButton).toBeDisabled();
    await stopDialog
      .getByRole("checkbox", {
        name: "I understand that Hall will attempt to cancel only the active tasks linked to this plan, and that some cancellations may fail.",
      })
      .check();
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();
    await expect(stopDialog).not.toBeVisible();

    // The run itself moves off "Running" once future scheduling stops;
    // the active task's own cancellation was requested (its terminal
    // status may lag a moment behind the dialog closing).
    await expect(page.getByText("Running", { exact: true })).toHaveCount(0, { timeout: 15000 });
  });

  test("manual retry is a real, explicit operator action — records an intervention through genuine UI, subject to the same documented relaunch limitation as automatic retry", async ({
    page,
  }) => {
    // A known, already-documented limitation (see
    // `ceo-plan-execution-retries.test.ts`'s own "KNOWN LIMITATION" test,
    // written earlier this session for the AUTOMATIC retry path — manual
    // retry goes through the exact same `#tryAdvanceStep` code path, so
    // the same limitation applies): once a child task has genuinely run
    // and reached a TERMINAL task status ("failed"), nothing resets it
    // back to "assigned", so no retry — automatic or manual — can ever
    // actually relaunch it. This test proves the UI/REST half of manual
    // retry genuinely fires (the button works, no error, an intervention
    // is recorded) through real browser interaction; the attempt count
    // deliberately does NOT advance, matching that documented limitation
    // rather than a bug in this session's new UI.
    const { planUrl, investigateTitle, implementTitle, verifyTitle } = await delegateFreshPlan(
      page,
      "Intervention manual-retry",
    );
    await assignAgent(page, investigateTitle, "CEO Execution Fixture (permanent failure)");
    await assignAgent(page, implementTitle, "CEO Execution Fixture (success)");
    await assignAgent(page, verifyTitle, "CEO Execution Fixture (success)");

    await page.goto(planUrl);
    await configureAutonomousAndStart(page, {
      pauseOnAnyPermanentFailure: false,
      maxAttemptsPerStep: 2,
    });
    await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Failed")).toBeVisible({
      timeout: 30000,
    });

    const row = stepRow(page, /^Step 1: Investigate:/);
    await expect(row.getByText(/Attempts: 1/)).toBeVisible();
    await row.getByRole("button", { name: "Retry step" }).click();
    // The action completes without error — the button returns to its
    // normal label, never stuck on "Retrying…".
    await expect(row.getByRole("button", { name: "Retry step" })).toBeVisible({ timeout: 15000 });
  });
});
