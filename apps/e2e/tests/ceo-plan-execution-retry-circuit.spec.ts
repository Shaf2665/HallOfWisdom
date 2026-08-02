import { expect, type Page, test } from "@playwright/test";

const API_BASE = "http://127.0.0.1:4310";

/**
 * Phase 15.3 — final retry/circuit contract, replacing the Phase 15.1/15.2
 * versions of this spec.
 *
 * Root cause of the earlier "Attempts: 2 did not appear within 30s" flake
 * (see the session report / `docs/architecture/0015-...md`, "Retry-due
 * wake mechanism"): a step parked in `retry_wait` was never woken on its
 * own once `nextEligibleAt` passed — it was only reconsidered the next
 * time some UNRELATED signal for the run happened to arrive, which is why
 * the previous version of this spec resorted to a manual Pause→Resume
 * nudge (itself sometimes unreliable, since a race in the scheduler's own
 * attempt-finalization bridge could leave an attempt row wedged at
 * `"running"`, blocking governed retry's own "previous attempt terminal"
 * precondition — hardened, see the same doc). Both are closed: the
 * scheduler now enqueues a durable, delayed `"retry_due"` signal at
 * `decideRetry()` time and arms exactly one wake timer for the soonest
 * such signal across every run. This spec proves that directly: NO
 * Pause/Resume, NO manual retry click, no signal of any kind after the
 * initial `Start execution` — only real elapsed time.
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

/** Kept short so the spec stays fast, but real: the assertions below wait out this exact value, never a blind guess. */
const RETRY_BACKOFF_SECONDS = 1;

function stepStatus(page: Page, stepTitlePattern: RegExp) {
  return page
    .getByRole("region", { name: "Autonomous execution" })
    .getByText(stepTitlePattern)
    .locator("..");
}

function stepRow(page: Page, stepTitlePattern: RegExp) {
  return page
    .getByRole("region", { name: "Autonomous execution" })
    .getByText(stepTitlePattern)
    .locator("..")
    .locator("..");
}

interface RunDetailAttempt {
  readonly id: string;
  readonly planStepId: string;
  readonly status: string;
  readonly taskRunId?: string;
}
interface RunDetail {
  readonly run: {
    readonly id: string;
    readonly status: string;
    readonly policySnapshot?: { readonly maxConsecutiveFailures: number };
  };
  readonly stepExecutions: readonly {
    readonly planStepId: string;
    readonly childTaskId: string;
    readonly status: string;
    readonly attemptCount: number;
  }[];
  readonly attempts: readonly RunDetailAttempt[];
  readonly circuit: {
    readonly state: string;
    readonly tripReason?: string;
    readonly consecutiveFailures?: number;
  };
}

/** Direct REST read, bypassing the UI entirely — the diagnostic contract this session's root-cause investigation relied on, kept here so a future regression is instantly distinguishable as backend vs. UI. */
async function fetchRunDetail(page: Page, planId: string): Promise<RunDetail> {
  const runsResp = await page.request.get(`${API_BASE}/api/v1/ceo-plan-runs`);
  const { runs } = (await runsResp.json()) as {
    runs: { readonly id: string; readonly planId: string }[];
  };
  const run = runs.find((r) => r.planId === planId);
  if (!run) throw new Error(`no run found for plan ${planId}`);
  const detailResp = await page.request.get(`${API_BASE}/api/v1/ceo-plan-runs/${run.id}`);
  return (await detailResp.json()) as RunDetail;
}

function extractPlanId(planUrl: string): string {
  const match = /\/ceo\/([^/?]+)/.exec(planUrl);
  if (!match) throw new Error(`could not extract planId from ${planUrl}`);
  return match[1] ?? "";
}

/**
 * Resolves the "Investigate" step's server-generated `planStepId` by
 * correlating its known task title through `/api/v1/tasks`, then matching
 * that task's id against `stepExecutions[].childTaskId` — never by
 * assuming array/position order, which `configureRun`'s step-seeding
 * order is not contractually guaranteed to preserve.
 */
async function findStepIdByTaskTitle(
  page: Page,
  detail: RunDetail,
  taskTitle: string,
): Promise<string> {
  const tasksResp = await page.request.get(`${API_BASE}/api/v1/tasks`);
  const { tasks } = (await tasksResp.json()) as {
    tasks: readonly { readonly task: { readonly taskId: string; readonly title: string } }[];
  };
  const record = tasks.find((t) => t.task.title === taskTitle);
  if (!record) throw new Error(`no task found with title ${taskTitle}`);
  const step = detail.stepExecutions.find((s) => s.childTaskId === record.task.taskId);
  if (!step) throw new Error(`no step execution found for task ${taskTitle}`);
  return step.planStepId;
}

test.describe("CEO plan execution — retry and circuit breaker (Phase 15.3 final contract)", () => {
  test("a transient failure recovers via a real, automatic second attempt — no Pause/Resume, no manual retry, REST and UI both prove it", async ({
    page,
  }) => {
    test.setTimeout(60000);
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
      if (errorText === "net::ERR_ABORTED") return;
      failedRequests.push(`${request.method()} ${request.url()}: ${errorText}`);
    });

    const { planUrl, investigateTitle, implementTitle, verifyTitle } = await delegateFreshPlan(
      page,
      "Retry recovers",
    );
    const planId = extractPlanId(planUrl);
    await assignAgent(
      page,
      investigateTitle,
      "CEO Execution Fixture (transient once, then success)",
    );
    await assignAgent(page, implementTitle, "CEO Execution Fixture (success)");
    await assignAgent(page, verifyTitle, "CEO Execution Fixture (success)");

    await page.goto(planUrl);
    await page.getByRole("button", { name: "Configure execution…" }).click();
    const configureDialog = page.getByRole("dialog", { name: "Configure execution" });
    await configureDialog
      .getByRole("radio", { name: /Autonomous — the scheduler starts eligible steps/ })
      .check();
    await configureDialog.getByLabel(/Max attempts per step/).fill("3");
    await configureDialog
      .getByLabel(/Retry backoff \(seconds\)/)
      .fill(String(RETRY_BACKOFF_SECONDS));
    await configureDialog.getByLabel(/Max consecutive failures/).fill("5");
    await configureDialog
      .getByRole("checkbox", { name: "Automatically retry transient (safe-to-retry) failures" })
      .check();
    await configureDialog
      .getByRole("checkbox", {
        name: "Pause the whole run for review on any permanent step failure",
      })
      .uncheck();
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

    // 1-6: attempt 1 fails and the step lands in "Waiting to retry" —
    // never "Failed" outright, since automatic retry is enabled.
    const investigateStatus = stepStatus(page, /^Step 1: Investigate:/);
    const investigateRow = stepRow(page, /^Step 1: Investigate:/);
    await expect(investigateStatus.getByText("Waiting to retry")).toBeVisible({ timeout: 30000 });
    await expect(investigateRow.getByText(/Attempts: 1/)).toBeVisible();
    const circuit = page.getByText("Circuit breaker", { exact: true }).locator("..");
    await expect(circuit.getByText("Closed", { exact: true })).toBeVisible();

    // 7: capture attempt-1's run id via REST.
    const beforeRetry = await fetchRunDetail(page, planId);
    const investigateStepId = await findStepIdByTaskTitle(page, beforeRetry, investigateTitle);
    const attempt1 = beforeRetry.attempts.find((a) => a.planStepId === investigateStepId);
    expect(attempt1).toBeDefined();
    expect(beforeRetry.attempts).toHaveLength(1);

    // 8: no early retry — asserted immediately, well before the
    // configured backoff, with no signal of any kind sent in between.
    const stillOne = await fetchRunDetail(page, planId);
    expect(stillOne.attempts).toHaveLength(1);

    // 9: wait for the event-driven retry mechanism — NO Pause/Resume, NO
    // manual retry click, no signal sent by this test at all. Sized to
    // this test's own configured backoff, not a blind guess.
    await page.waitForTimeout(RETRY_BACKOFF_SECONDS * 1000 + 2000);

    // 10: REST run detail shows attempt count 2 for the Investigate step
    // — `attempts` is run-wide (every step's attempts), not step-scoped,
    // so by the time this poll happens the (already-succeeding)
    // Implement/Verify steps may well have their own single attempts
    // recorded too; only Investigate's own count is the point here.
    const afterRetry = await fetchRunDetail(page, planId);
    const investigateAttemptsAfterRetry = afterRetry.attempts.filter(
      (a) => a.planStepId === investigateStepId,
    );
    expect(investigateAttemptsAfterRetry).toHaveLength(2);
    const investigateStep = afterRetry.stepExecutions.find(
      (s) => s.planStepId === investigateStepId,
    );
    expect(investigateStep?.attemptCount).toBe(2);

    // 11: UI shows attempt count 2 — the real, visible browser state, not
    // just the REST diagnostic.
    await expect(investigateRow.getByText(/Attempts: 2/)).toBeVisible({ timeout: 5000 });

    // 12-13: capture attempt-2's run id and assert it differs from attempt 1.
    const attempt2 = investigateAttemptsAfterRetry.find((a) => a.id !== attempt1?.id);
    expect(attempt2).toBeDefined();
    expect(attempt2?.taskRunId).toBeDefined();
    expect(attempt1?.taskRunId).toBeDefined();
    expect(attempt2?.taskRunId).not.toBe(attempt1?.taskRunId);

    // 14: attempt-1 history remains visible — "(2 recorded)" reflects both
    // attempt rows, not just the current one.
    await expect(investigateRow.getByText(/\(2 recorded\)/)).toBeVisible();

    // 15: attempt 2 succeeds (this fixture fails only the first attempt
    // for a given task) — the whole plan eventually completes.
    await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible({
      timeout: 30000,
    });

    // 16: no duplicate attempt 2 — exactly two attempt rows for this step, ever.
    const final = await fetchRunDetail(page, planId);
    const finalInvestigateAttempts = final.attempts.filter(
      (a) => a.planStepId === investigateStepId,
    );
    expect(finalInvestigateAttempts).toHaveLength(2);

    // 17: already proven above — no Pause/Resume/manual-retry action was
    // ever taken in this test, and the retry still happened.

    // 18-19: no raw fixture stderr anywhere on the page, and no console,
    // hydration, or CORS error occurred anywhere in the flow.
    await expect(page.getByText("MOCK_EXECUTION_FAILED", { exact: false })).toHaveCount(0);
    expect(consoleIssues.some((text) => /hydration/i.test(text))).toBe(false);
    expect(consoleIssues, `unexpected console/page errors: ${consoleIssues.join("; ")}`).toEqual(
      [],
    );
    expect(
      failedRequests,
      `unexpected failed requests (possible CORS): ${failedRequests.join("; ")}`,
    ).toEqual([]);
  });

  /**
   * Phase 15.4 — the threshold-above-1 trip this file's own history (see
   * the comment this test replaces, still worth reading for the root
   * cause) previously documented as unreachable. Root cause fixed in
   * `ceo-plan-execution-scheduler.ts`'s `#tryAdvanceStep`: a successful
   * launch no longer calls `recordCircuitProgress` — only a step actually
   * COMPLETING does. This test is the browser-level proof: threshold 2,
   * two real automatic attempts, the same safe transient code both times,
   * no Pause/Resume, no manual retry, no threshold-of-1 workaround.
   */
  test("a repeated transient failure trips the circuit breaker above threshold 1 — real automatic retries, threshold 2, no third attempt", async ({
    page,
  }) => {
    test.setTimeout(60000);
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
      if (errorText === "net::ERR_ABORTED") return;
      failedRequests.push(`${request.method()} ${request.url()}: ${errorText}`);
    });

    const { planUrl, investigateTitle, implementTitle, verifyTitle } = await delegateFreshPlan(
      page,
      "Circuit trips",
    );
    const planId = extractPlanId(planUrl);
    // Always fails, retryable: true, the SAME safe transient code every
    // single attempt — deterministic, never "transient once then success".
    await assignAgent(page, investigateTitle, "CEO Execution Fixture (transient failure)");
    await assignAgent(page, implementTitle, "CEO Execution Fixture (success)");
    await assignAgent(page, verifyTitle, "CEO Execution Fixture (success)");

    await page.goto(planUrl);
    await page.getByRole("button", { name: "Configure execution…" }).click();
    const configureDialog = page.getByRole("dialog", { name: "Configure execution" });
    await configureDialog
      .getByRole("radio", { name: /Autonomous — the scheduler starts eligible steps/ })
      .check();
    await configureDialog.getByLabel(/Max attempts per step/).fill("3");
    await configureDialog
      .getByLabel(/Retry backoff \(seconds\)/)
      .fill(String(RETRY_BACKOFF_SECONDS));
    // Threshold 2 — never the old threshold-of-1 workaround, which could
    // never distinguish "the launch-time reset bug is fixed" from "the
    // circuit trips on literally any first failure regardless of the fix".
    await configureDialog.getByLabel(/Max consecutive failures/).fill("2");
    await configureDialog
      .getByRole("checkbox", { name: "Automatically retry transient (safe-to-retry) failures" })
      .check();
    await configureDialog
      .getByRole("checkbox", {
        name: "Pause the whole run for review on any permanent step failure",
      })
      .uncheck();
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

    // 1-2: attempt 1 appears and fails; the step enters "Waiting to retry"
    // — never "Failed" outright, since automatic retry is enabled and the
    // circuit hasn't tripped yet (1 < threshold 2).
    const investigateStatus = stepStatus(page, /^Step 1: Investigate:/);
    const investigateRow = stepRow(page, /^Step 1: Investigate:/);
    await expect(investigateStatus.getByText("Waiting to retry")).toBeVisible({ timeout: 30000 });
    await expect(investigateRow.getByText(/Attempts: 1/)).toBeVisible();
    const circuit = page.getByText("Circuit breaker", { exact: true }).locator("..");
    await expect(circuit.getByText("Closed", { exact: true })).toBeVisible();

    const afterAttempt1 = await fetchRunDetail(page, planId);
    const investigateStepId = await findStepIdByTaskTitle(page, afterAttempt1, investigateTitle);
    const attempt1 = afterAttempt1.attempts.find((a) => a.planStepId === investigateStepId);
    expect(attempt1).toBeDefined();
    expect(afterAttempt1.attempts.filter((a) => a.planStepId === investigateStepId)).toHaveLength(
      1,
    );

    // 3-5: wait for the SAME event-driven retry mechanism spec 1 proves —
    // no Pause/Resume, no manual retry click, no signal of any kind sent
    // by this test. Attempt 2 appears automatically with a genuinely new
    // task-run ID, and attempt 1's own history is preserved. This fixture
    // fails immediately (`stepDelayMs: 0`), so attempt 2 both launches and
    // fails again well within one backoff period — the circuit trips at
    // that point, so waiting a single backoff period (plus margin) is
    // sufficient to observe exactly 2 attempts, never a 3rd.
    await page.waitForTimeout(RETRY_BACKOFF_SECONDS * 1000 + 2000);
    const afterRetry = await fetchRunDetail(page, planId);
    const investigateAttemptsAfterRetry = afterRetry.attempts.filter(
      (a) => a.planStepId === investigateStepId,
    );
    expect(investigateAttemptsAfterRetry).toHaveLength(2);
    const attempt2 = investigateAttemptsAfterRetry.find((a) => a.id !== attempt1?.id);
    expect(attempt2).toBeDefined();
    expect(attempt2?.taskRunId).toBeDefined();
    expect(attempt1?.taskRunId).toBeDefined();
    expect(attempt2?.taskRunId).not.toBe(attempt1?.taskRunId);
    // Attempt 1's own row is still present, unmodified, alongside attempt 2.
    expect(investigateAttemptsAfterRetry.some((a) => a.id === attempt1?.id)).toBe(true);

    // 6-7: attempt 2 (same fixture — always fails) trips the circuit at
    // exactly 2 consecutive failures, and the run moves to "Awaiting
    // intervention". This is the assertion that would have failed before
    // this session's fix: the launch of attempt 2 must NOT have reset
    // `consecutiveFailures` back to 0, or a second failure could never
    // reach threshold 2.
    await expect(circuit.getByText(/^Open/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Awaiting intervention").first()).toBeVisible();

    // 8: exactly two attempts exist for this step.
    const afterTrip = await fetchRunDetail(page, planId);
    const tripAttempts = afterTrip.attempts.filter((a) => a.planStepId === investigateStepId);
    expect(tripAttempts).toHaveLength(2);
    expect(afterTrip.circuit.state).toBe("open");

    // 9: bounded observation window — wait past ANOTHER full backoff
    // period with no operator action of any kind, and confirm no third
    // attempt ever appears. An open circuit blocks new claims outright
    // (`#tryAdvanceStep` returns immediately when `circuit.state ===
    // "open"`), so this is a real assertion, not a timing coincidence.
    await page.waitForTimeout(RETRY_BACKOFF_SECONDS * 1000 + 1500);
    const afterWindow = await fetchRunDetail(page, planId);
    const finalAttempts = afterWindow.attempts.filter((a) => a.planStepId === investigateStepId);
    expect(finalAttempts).toHaveLength(2);
    expect(afterWindow.circuit.state).toBe("open");

    // 10: exactly one circuit_opened event.
    const eventsResp = await page.request.get(
      `${API_BASE}/api/v1/ceo-plan-runs/${afterWindow.run.id}/events`,
    );
    const { events } = (await eventsResp.json()) as {
      readonly events: readonly { readonly type: string }[];
    };
    expect(events.filter((e) => e.type === "ceo.execution.circuit_opened")).toHaveLength(1);

    // 11: exactly one bounded Board alert — posted to the ORIGINAL
    // backlog task's own communication board (`postBoardAudit`'s real
    // production path, not a test-only log), dedup-gated so a duplicate
    // pause-for-intervention call can never double-post it.
    const planResp = await page.request.get(`${API_BASE}/api/v1/ceo-plans/${planId}`);
    const { plan } = (await planResp.json()) as {
      readonly plan: { readonly parentTaskId: string };
    };
    const boardsResp = await page.request.get(`${API_BASE}/api/v1/boards`);
    const { boards } = (await boardsResp.json()) as {
      readonly boards: readonly { readonly boardId: string; readonly taskId?: string }[];
    };
    const board = boards.find((b) => b.taskId === plan.parentTaskId);
    if (!board) throw new Error(`no board found for parent task ${plan.parentTaskId}`);
    const messagesResp = await page.request.get(
      `${API_BASE}/api/v1/boards/${board.boardId}/messages`,
    );
    const { messages } = (await messagesResp.json()) as {
      readonly messages: readonly { readonly author: { readonly displayName: string } }[];
    };
    expect(messages.filter((m) => m.author.displayName === "Execution Scheduler")).toHaveLength(1);

    // 12-15: no raw fixture stderr anywhere on the page, and no console,
    // hydration, or CORS/network error occurred anywhere in the flow.
    await expect(page.getByText("MOCK_EXECUTION_FAILED", { exact: false })).toHaveCount(0);
    expect(consoleIssues.some((text) => /hydration/i.test(text))).toBe(false);
    expect(consoleIssues, `unexpected console/page errors: ${consoleIssues.join("; ")}`).toEqual(
      [],
    );
    expect(
      failedRequests,
      `unexpected failed requests (possible CORS): ${failedRequests.join("; ")}`,
    ).toEqual([]);

    // 16: explicit intervention is required — no automatic un-trip of any
    // kind exists; only an operator Resume clears the circuit (see
    // `resumeRun`'s own doc comment in both store implementations and the
    // Phase 15.4 unit matrix's scenario 18). Re-confirm the run is STILL
    // awaiting intervention after every assertion above, not just
    // momentarily.
    const stillAwaiting = await fetchRunDetail(page, planId);
    expect(stillAwaiting.run.status).toBe("awaiting_intervention");
  });
});
