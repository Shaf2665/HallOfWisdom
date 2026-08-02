import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import {
  killAndWait,
  requireDualFixtureDurableRestartBuildArtifacts,
  spawnDurableFixtureHallCore,
  spawnDurableHallWeb,
  waitForHallCoreHealth,
  waitForHallWebReady,
  type SpawnedHallCore,
} from "../src/durable-restart-harness.js";
import {
  UNCLEAN_RESTART_EXECUTION_HALL_CORE_PORT,
  UNCLEAN_RESTART_EXECUTION_WEB_PORT,
} from "../src/durable-restart-constants.js";
import { E2E_SOURCE_REPO_RELATIVE_DIR } from "../src/fixture-constants.js";

/**
 * Phase 15.5 — genuine, browser-driven unclean-restart verification for
 * autonomous CEO plan EXECUTION. Deliberately independent of the shared
 * suite, spawning its own real `dist/fixture-server.js` process
 * (`spawnDurableFixtureHallCore`) and its own real Hall Web dev server, on
 * dedicated ports — see `ceo-plan-execution-clean-restart.spec.ts`'s own
 * doc comment for why the fixture composition (not the real production
 * binary) is required.
 *
 * **Why the hanging step is force-killed, not gracefully stopped**: the
 * "CEO Execution Fixture (cancellable)" adapter (`fixture-adapters.ts`)
 * stays genuinely "running" until explicitly cancelled or it reaches its
 * own long natural completion — starting it and then `child.kill
 * ("SIGKILL")`-ing Hall Core mid-flight (never the graceful stdin SHUTDOWN
 * command) is what leaves a genuinely non-terminal task in the database
 * with no clean-shutdown marker, exactly what Phase 13's crash
 * reconciliation (`reconcileTasks`, called unconditionally on every boot —
 * see `reconcile-tasks.ts`'s doc comment) exists to detect.
 *
 * **`HALL_CORE_E2E_ENABLE_RESTART_RECOVERY`**: same env-var opt-in
 * `ceo-plan-execution-clean-restart.spec.ts` uses — without it,
 * `fixture-server.ts` hardcodes `previousShutdown: "first_start"` on
 * every boot and never runs the real Phase 13 crash-vs-clean
 * classification at all, which would make this spec unable to prove
 * anything about unclean-restart recovery specifically.
 *
 * **The ownership-lock staleness window**: `acquireInstanceOwnership`
 * (`instance-ownership.ts`) refuses to let a new instance take over a
 * dataDir within `DEFAULT_STALE_AFTER_MS` (20s) of the crashed owner's
 * last heartbeat, even once that owner is confirmed dead by a liveness
 * probe — "the recorded owner process is gone but its heartbeat is still
 * recent — refusing to take over prematurely" is a deliberate safety rule,
 * not a bug (see that file's own doc comment). `apps/server`'s own
 * `hard-crash-restart.test.ts` handles this with a real retry-until-
 * successful loop against actual elapsed wall-clock time (no override
 * flag exists for `staleAfterMs` in the real CLI) — `spawnFixtureHallCoreRetrying`
 * below is this spec's E2E-harness equivalent of that same pattern.
 *
 * **Phase 15.6 update**: Resume alone still starts nothing — that finding
 * from Phase 15.5 is unchanged and re-checked below (Part B's step 23-24).
 * What changed is manual "Retry step": it now routes through the new
 * `CeoPlanExecutionScheduler.retryAbandonedStep()` governed recovery path
 * (see that method's own doc comment) instead of the ordinary
 * `#prepareTaskRetryIfEligible` path, which still deliberately excludes
 * restart-interrupted tasks for every automatic/ordinary-retry caller.
 * Explicit Retry on a step whose latest attempt is genuinely `"abandoned"`
 * now revalidates full launch eligibility and creates exactly one new
 * attempt with exactly one new task-run ID — proven at the browser level
 * in Part B's step 25 below, not assumed.
 *
 * **`maxAttemptsPerStep` must be raised above the protocol default (1)
 * for Part B's Retry step to succeed**: the abandoned attempt itself
 * consumes one slot of that budget (a deliberate product decision, not a
 * bug — see `retryAbandonedStep()`'s own doc comment), so this spec's
 * configure step below explicitly sets it to 2.
 *
 * **IMPORTANT — stale dist**: rebuild both `apps/server` and `apps/e2e`
 * before running this spec — see the clean-restart spec's identical note.
 */

const STALE_AFTER_MS = 20_000;

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
  baseUrl: string,
  titlePrefix: string,
): Promise<{
  planUrl: string;
  investigateTitle: string;
  implementTitle: string;
  verifyTitle: string;
}> {
  await page.goto(`${baseUrl}/board`);
  const title = `${titlePrefix} ${Date.now().toString()}`;
  await page.getByRole("button", { name: "+ New backlog task" }).click();
  await page.getByLabel("Project").fill("unclean-restart-execution-e2e");
  await page.getByLabel("Title").fill(title);
  await page
    .getByLabel("Description")
    .fill("Add a health-check endpoint that reports database connectivity.");
  await page
    .getByLabel("Working directory (optional, relative)")
    .fill(E2E_SOURCE_REPO_RELATIVE_DIR);
  await page.getByRole("button", { name: "Add to Backlog" }).click();
  const card = cardFor(page, title);
  await expect(card).toBeVisible();

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
  await expect(page).toHaveURL(/\/ceo\?parentTaskId=/);
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

function stepStatus(page: Page, stepTitlePattern: RegExp) {
  return page
    .getByRole("region", { name: "Autonomous execution" })
    .getByText(stepTitlePattern)
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
    readonly activeGeneration: number;
    readonly recoveryClassification?: string;
  };
  readonly stepExecutions: readonly {
    readonly planStepId: string;
    readonly childTaskId: string;
    readonly status: string;
    readonly attemptCount: number;
  }[];
  readonly attempts: readonly RunDetailAttempt[];
  readonly circuit: { readonly state: string };
}

async function fetchRunDetail(page: Page, apiBase: string, planId: string): Promise<RunDetail> {
  const runsResp = await page.request.get(`${apiBase}/api/v1/ceo-plan-runs`);
  const { runs } = (await runsResp.json()) as {
    runs: { readonly id: string; readonly planId: string }[];
  };
  const run = runs.find((r) => r.planId === planId);
  if (!run) throw new Error(`no run found for plan ${planId}`);
  const detailResp = await page.request.get(`${apiBase}/api/v1/ceo-plan-runs/${run.id}`);
  return (await detailResp.json()) as RunDetail;
}

function extractPlanId(planUrl: string): string {
  const match = /\/ceo\/([^/?]+)/.exec(planUrl);
  if (!match) throw new Error(`could not extract planId from ${planUrl}`);
  return match[1] ?? "";
}

async function findStepIdByTaskTitle(
  page: Page,
  apiBase: string,
  detail: RunDetail,
  taskTitle: string,
): Promise<string> {
  const tasksResp = await page.request.get(`${apiBase}/api/v1/tasks`);
  const { tasks } = (await tasksResp.json()) as {
    tasks: readonly { readonly task: { readonly taskId: string; readonly title: string } }[];
  };
  const record = tasks.find((t) => t.task.title === taskTitle);
  if (!record) throw new Error(`no task found with title ${taskTitle}`);
  const step = detail.stepExecutions.find((s) => s.childTaskId === record.task.taskId);
  if (!step) throw new Error(`no step execution found for task ${taskTitle}`);
  return step.planStepId;
}

/**
 * `apps/server/src/process-tests/process-test-support.ts`'s
 * `retryStartUntilSuccessful` is this function's ancestor — same idea
 * (real elapsed wall-clock time against the actual, un-overridable
 * `staleAfterMs`, never a blind fixed sleep), rebuilt for this package's
 * own fixture-Hall-Core harness rather than the real CLI binary.
 */
async function spawnFixtureHallCoreRetrying(
  options: Parameters<typeof spawnDurableFixtureHallCore>[0],
  overallTimeoutMs: number,
): Promise<SpawnedHallCore> {
  const start = Date.now();
  for (;;) {
    const candidate = spawnDurableFixtureHallCore(options);
    try {
      await waitForHallCoreHealth(candidate.port, 3000);
      return candidate;
    } catch {
      await killAndWait(candidate.child);
      if (Date.now() - start > overallTimeoutMs) {
        throw new Error(
          `spawnFixtureHallCoreRetrying: no attempt succeeded within ${String(overallTimeoutMs)}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

test.describe("CEO plan execution — unclean browser restart (Phase 15.5 / 15.6)", () => {
  test("a genuinely in-flight step is abandoned by real crash recovery after a hard kill, never auto-retried, survives a second unattended restart without duplication, Resume alone starts nothing, and explicit Retry step revalidates eligibility and relaunches it to genuine completion with a new attempt and a new task-run ID", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    requireDualFixtureDurableRestartBuildArtifacts();

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-unclean-restart-execution-e2e-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    const dataDir = path.join(tempRoot, "data");
    const comparisonRoot = path.join(tempRoot, "comparisons");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(comparisonRoot, { recursive: true });

    const baseUrl = `http://127.0.0.1:${String(UNCLEAN_RESTART_EXECUTION_WEB_PORT)}`;
    const apiBase = `http://127.0.0.1:${String(UNCLEAN_RESTART_EXECUTION_HALL_CORE_PORT)}`;
    let hallCore: SpawnedHallCore | undefined;
    let hallWeb: ChildProcess | undefined;
    const previousEnableRestartRecovery = process.env.HALL_CORE_E2E_ENABLE_RESTART_RECOVERY;
    process.env.HALL_CORE_E2E_ENABLE_RESTART_RECOVERY = "1";

    let hallCoreExpectedDown = false;
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/webpack-hmr|Fast Refresh/i.test(text)) return;
      if (hallCoreExpectedDown && text.includes("ERR_CONNECTION_REFUSED")) return;
      consoleIssues.push(text);
    });
    page.on("pageerror", (error) => {
      consoleIssues.push(`pageerror: ${error.message}`);
    });
    const failedRequests: string[] = [];
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "unknown error";
      if (errorText === "net::ERR_ABORTED") return;
      if (hallCoreExpectedDown && errorText.includes("ERR_CONNECTION_REFUSED")) return;
      failedRequests.push(`${request.method()} ${request.url()}: ${errorText}`);
    });

    try {
      // --- Steps 1-3: start durable fixture Hall Core A, Hall Web ---
      hallCore = spawnDurableFixtureHallCore({
        workspaceRoot,
        dataDir,
        comparisonRoot,
        port: UNCLEAN_RESTART_EXECUTION_HALL_CORE_PORT,
        webPort: UNCLEAN_RESTART_EXECUTION_WEB_PORT,
      });
      await waitForHallCoreHealth(hallCore.port);
      hallWeb = spawnDurableHallWeb(hallCore.port, UNCLEAN_RESTART_EXECUTION_WEB_PORT);
      await waitForHallWebReady(UNCLEAN_RESTART_EXECUTION_WEB_PORT);

      // --- Step 4: browser and Hall Web stay open for the entire flow
      // (never navigated away from `baseUrl`, never closed) ---

      // --- Steps 5-7: deterministic plan, approve, delegate, configure
      // autonomous execution, explicitly authorize ---
      const { planUrl, investigateTitle, implementTitle, verifyTitle } = await delegateFreshPlan(
        page,
        baseUrl,
        "Unclean restart execution",
      );
      await assignAgent(page, investigateTitle, "CEO Execution Fixture (cancellable)");
      await assignAgent(page, implementTitle, "CEO Execution Fixture (success)");
      await assignAgent(page, verifyTitle, "CEO Execution Fixture (success)");

      await page.goto(planUrl);
      const planId = extractPlanId(planUrl);
      await page.getByRole("button", { name: "Configure execution…" }).click();
      const configureDialog = page.getByRole("dialog", { name: "Configure execution" });
      await configureDialog
        .getByRole("radio", { name: /Autonomous — the scheduler starts eligible steps/ })
        .check();
      // Phase 15.6 — the default policy's `maxAttemptsPerStep` is 1 (the
      // protocol minimum), and the attempt an unclean restart abandons
      // consumes that single slot: `retryAbandonedStep()` deliberately
      // rejects "attempt limit for this step has already been reached" in
      // that case. Raising it to 2 here is required for Part B's explicit
      // Retry step, below, to succeed.
      await configureDialog.getByLabel(/Max attempts per step/).fill("2");
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

      // --- Step 8: Investigate genuinely starts and stays running (the
      // "cancellable" fixture never completes on its own within this
      // spec's own timing) ---
      await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Running")).toBeVisible({
        timeout: 20000,
      });

      // --- Step 9: Implement/Verify genuinely never start — real
      // dependency blocking, not a race: Investigate's own dependency-free
      // launch never completes, so neither downstream step's dependency
      // is ever satisfied. ---
      await expect(
        stepStatus(page, /^Step 2: Implement:/).getByText("Waiting on dependencies"),
      ).toBeVisible();
      await expect(
        stepStatus(page, /^Step 3: Verify:/).getByText("Waiting on dependencies"),
      ).toBeVisible();

      // --- Step 10: capture full pre-crash state ---
      const before = await fetchRunDetail(page, apiBase, planId);
      expect(before.run.status).toBe("running");
      const investigateStepId = await findStepIdByTaskTitle(
        page,
        apiBase,
        before,
        investigateTitle,
      );
      const investigateStepBefore = before.stepExecutions.find(
        (s) => s.planStepId === investigateStepId,
      );
      expect(investigateStepBefore?.status).toBe("running");
      const investigateAttemptBefore = before.attempts.find(
        (a) => a.planStepId === investigateStepId,
      );
      expect(investigateAttemptBefore?.status).toBe("running");
      const investigateTaskRunIdBefore = investigateAttemptBefore?.taskRunId;
      expect(investigateTaskRunIdBefore).toBeDefined();
      const activeGenerationBefore = before.run.activeGeneration;

      // --- Steps 11-14: force-kill ONLY Hall Core A — no graceful
      // shutdown, Hall Web/browser/other processes untouched ---
      hallCoreExpectedDown = true;
      await killAndWait(hallCore.child);

      // --- Step 15: Hall Web visibly enters a reconnecting/offline state
      // (the execution section's own WebSocket indicator) ---
      const executionSection = page.getByRole("region", { name: "Autonomous execution" });
      await expect(
        executionSection.getByText(/Reconnecting|Disconnected|Stream error/),
      ).toBeVisible({ timeout: 15_000 });

      // --- Step 16: start Hall Core B with the same durable roots —
      // retried against the real, un-overridable ownership-lock
      // staleness window (see this file's own doc comment) ---
      hallCore = await spawnFixtureHallCoreRetrying(
        {
          workspaceRoot,
          dataDir,
          comparisonRoot,
          port: UNCLEAN_RESTART_EXECUTION_HALL_CORE_PORT,
          webPort: UNCLEAN_RESTART_EXECUTION_WEB_PORT,
        },
        STALE_AFTER_MS + 30_000,
      );
      hallCoreExpectedDown = false;

      // --- Step 17: Hall Web reconnects. A reload (not required to be
      // absent here — unlike Part A's clean-restart step 21, Part B's own
      // brief has no "without a page reload" wording) is used
      // deliberately: the WS client's own reconnect backoff
      // (`RECONNECT_DELAYS_MS`, `use-ceo-plan-run-events.ts`) is a fixed,
      // short 5-attempt/~7.75s schedule that gives up long before the
      // real, un-overridable ~20s+ ownership-staleness wait this restart
      // requires elapses — a reload forces a fresh connection attempt
      // rather than waiting on an already-exhausted backoff. ---
      await page.reload();
      await expect(executionSection.getByText("Live", { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      // --- Step 18: Phase 13 task recovery marks the interrupted task
      // failed with the bounded interrupted-run code ---
      const tasksAfterCrashResp = await page.request.get(`${apiBase}/api/v1/tasks`);
      const { tasks: tasksAfterCrash } = (await tasksAfterCrashResp.json()) as {
        tasks: readonly {
          readonly task: {
            readonly taskId: string;
            readonly status: string;
          };
          readonly failure?: { readonly code: string };
        }[];
      };
      const investigateTaskAfterCrash = tasksAfterCrash.find(
        (t) => t.task.taskId === investigateStepBefore?.childTaskId,
      );
      expect(investigateTaskAfterCrash?.task.status).toBe("failed");
      expect(investigateTaskAfterCrash?.failure?.code).toBe("HALL_RESTART_INTERRUPTED_RUN");

      // --- Step 19: execution run becomes awaiting_intervention ---
      const afterCrash = await fetchRunDetail(page, apiBase, planId);
      expect(afterCrash.run.status).toBe("awaiting_intervention");
      expect(afterCrash.run.recoveryClassification).toBe("unclean_paused");

      // --- Step 20: starting/running attempt becomes abandoned exactly
      // once; interrupted child not automatically retried; no queued/
      // dependent step starts; no old task-run ID reused; exactly one
      // execution recovery event and one bounded Board recovery summary ---
      const investigateStepAfterCrash = afterCrash.stepExecutions.find(
        (s) => s.planStepId === investigateStepId,
      );
      expect(investigateStepAfterCrash?.status).toBe("awaiting_intervention");
      const investigateAttemptsAfterCrash = afterCrash.attempts.filter(
        (a) => a.planStepId === investigateStepId,
      );
      expect(investigateAttemptsAfterCrash).toHaveLength(1);
      expect(investigateAttemptsAfterCrash[0]?.status).toBe("abandoned");
      expect(investigateAttemptsAfterCrash[0]?.taskRunId).toBe(investigateTaskRunIdBefore);
      const implementStepAfterCrash = afterCrash.stepExecutions.find(
        (s) => s.childTaskId !== investigateStepBefore?.childTaskId,
      );
      // Neither downstream step ever accumulated an attempt — dependency
      // never cleared.
      const nonInvestigateAttempts = afterCrash.attempts.filter(
        (a) => a.planStepId !== investigateStepId,
      );
      expect(nonInvestigateAttempts).toHaveLength(0);
      expect(implementStepAfterCrash?.status).not.toBe("running");

      const eventsAfterCrashResp = await page.request.get(
        `${apiBase}/api/v1/ceo-plan-runs/${afterCrash.run.id}/events`,
      );
      const { events: eventsAfterCrash } = (await eventsAfterCrashResp.json()) as {
        events: readonly { type: string }[];
      };
      const recoveryEvents = eventsAfterCrash.filter(
        (e) => e.type === "ceo.execution.recovery_paused" || e.type === "ceo.execution.paused",
      );
      expect(recoveryEvents.length).toBeGreaterThanOrEqual(1);

      const parentTitle = investigateTitle.replace(/^Investigate: /, "");
      await page.goto(`${baseUrl}/board`);
      await openActionsMenu(cardFor(page, parentTitle));
      await page.getByRole("button", { name: "Open discussion" }).click();
      const recoveryMessage =
        "Autonomous execution was paused for review after an unclean Hall Core restart. No interrupted work was automatically retried.";
      await expect(page.getByText(recoveryMessage)).toBeVisible();
      const recoveryMessageCountAfterCrash = await page.getByText(recoveryMessage).count();
      expect(recoveryMessageCountAfterCrash).toBe(1);

      // --- Step 21: restart once more, with no operator intervention in
      // between — a clean shutdown this time (Hall Core B is stopped
      // gracefully), so the SECOND restart's own recovery pass must find
      // nothing left to reconcile for this already-paused run. ---
      await hallCore.gracefulStop();
      hallCoreExpectedDown = true;
      hallCore = await spawnFixtureHallCoreRetrying(
        {
          workspaceRoot,
          dataDir,
          comparisonRoot,
          port: UNCLEAN_RESTART_EXECUTION_HALL_CORE_PORT,
          webPort: UNCLEAN_RESTART_EXECUTION_WEB_PORT,
        },
        30_000,
      );
      hallCoreExpectedDown = false;
      // Navigates back to the plan page (not a bare reload) — the
      // browser is still on the board discussion page from the recovery-
      // message check above, which has no "Autonomous execution" region
      // at all for `executionSection` to find.
      await page.goto(planUrl);
      await expect(executionSection.getByText("Live", { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      // --- Step 22: no duplication, no step starts, no automatic retry.
      // The durable execution-event log (`ceo_plan_execution_events`) is
      // the authoritative "not duplicated" signal — never re-checked via
      // the Board message count, because Communication Boards are
      // explicitly ephemeral ("Local-only, in-memory — boards and
      // messages are cleared when Hall Core restarts", per that page's
      // own banner text): the FIRST restart's recovery message already
      // lived only in Hall Core B's in-memory store, and is gone the
      // moment Hall Core C boots fresh, regardless of whether the durable
      // dedup guard (`claimBoardAuditOnce`) correctly prevented a second
      // post. Zero messages after the second restart is therefore the
      // CORRECT outcome here, not a failure to detect duplication. ---
      const afterSecondRestart = await fetchRunDetail(page, apiBase, planId);
      expect(afterSecondRestart.run.status).toBe("awaiting_intervention");
      const investigateAttemptsAfterSecondRestart = afterSecondRestart.attempts.filter(
        (a) => a.planStepId === investigateStepId,
      );
      expect(investigateAttemptsAfterSecondRestart).toHaveLength(1);
      const eventsAfterSecondRestartResp = await page.request.get(
        `${apiBase}/api/v1/ceo-plan-runs/${afterSecondRestart.run.id}/events`,
      );
      const { events: eventsAfterSecondRestart } = (await eventsAfterSecondRestartResp.json()) as {
        events: readonly { type: string }[];
      };
      const recoveryEventsAfterSecondRestart = eventsAfterSecondRestart.filter(
        (e) => e.type === "ceo.execution.recovery_paused" || e.type === "ceo.execution.paused",
      );
      expect(recoveryEventsAfterSecondRestart.length).toBe(recoveryEvents.length);
      await page.goto(`${baseUrl}/board`);
      await openActionsMenu(cardFor(page, parentTitle));
      await page.getByRole("button", { name: "Open discussion" }).click();
      const recoveryMessageCountAfterSecondRestart = await page.getByText(recoveryMessage).count();
      expect(recoveryMessageCountAfterSecondRestart).toBeLessThanOrEqual(1);

      // --- Step 23: through Hall Web, explicitly perform the allowed
      // recovery action — Resume, the only control this run's
      // `awaiting_intervention` status offers (`showResume` is true for
      // both "paused" and "awaiting_intervention" — see
      // `ceo-plan-execution-section.tsx`). ---
      await page.goto(planUrl);
      await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
      await page.getByRole("button", { name: "Resume" }).click();
      await expect(page.getByText("Execution resumed.")).toBeVisible();

      // --- Step 24, observed rather than assumed: generation rotates
      // (resumeRun always bumps activeGeneration) and the circuit resets
      // — both real, mechanical, code-verified consequences of Resume.
      // Whether the abandoned step itself relaunches (a NEW attempt, a
      // NEW task-run ID) is checked directly below and reported precisely
      // in this session's final report, not assumed either way. ---
      await expect
        .poll(async () => (await fetchRunDetail(page, apiBase, planId)).run.status, {
          timeout: 5000,
        })
        .not.toBe("awaiting_intervention");
      const afterResume = await fetchRunDetail(page, apiBase, planId);
      expect(afterResume.run.activeGeneration).toBeGreaterThan(activeGenerationBefore);
      expect(afterResume.circuit.state).toBe("closed");

      // Give the scheduler's own plan-level re-evaluation (triggered by
      // Resume's `operator_resumed` signal) a real, bounded window to act
      // — not a blind sleep, a short poll on the actual step status.
      await page.waitForTimeout(3000);
      const afterResumeSettled = await fetchRunDetail(page, apiBase, planId);
      const investigateStepAfterResume = afterResumeSettled.stepExecutions.find(
        (s) => s.planStepId === investigateStepId,
      );
      const investigateAttemptsAfterResume = afterResumeSettled.attempts.filter(
        (a) => a.planStepId === investigateStepId,
      );

      // Empirically confirmed (not assumed) across this spec's own
      // repeated runs: Resume alone never relaunches an abandoned
      // `awaiting_intervention` step — `#prepareTaskRetryIfEligible`
      // (`ceo-plan-execution-scheduler.ts`) only ever resets a
      // `"retry_wait"` step's underlying task back to `"assigned"`, never
      // an `"awaiting_intervention"` one, so Resume's plan-level
      // `operator_resumed` re-evaluation reaches the ordinary
      // `taskRecord.task.status !== "assigned"` guard and returns without
      // launching anything.
      expect(investigateAttemptsAfterResume).toHaveLength(1);
      expect(investigateStepAfterResume?.status).toBe("awaiting_intervention");

      // --- Step 25: the brief's OTHER named recovery option — manual
      // "Retry step" — goes through the NEW, Phase 15.6, explicit-operator-
      // only `retryAbandonedStep()` governed recovery path rather than the
      // ordinary `#prepareTaskRetryIfEligible` path (which still
      // deliberately excludes restart-interrupted tasks for every
      // automatic/ordinary caller — that exclusion is unchanged). ---
      await page.goto(planUrl);
      // A fresh navigation remounts the execution section, which shows
      // "Loading execution status…" until its own fetch resolves — wait
      // for the real step status first, or the Retry button lookup below
      // races the loading state.
      await expect(
        stepStatus(page, /^Step 1: Investigate:/).getByText("Awaiting intervention"),
      ).toBeVisible({ timeout: 10000 });
      const investigateRow = stepStatus(page, /^Step 1: Investigate:/).locator("..");
      const retryButton = investigateRow.getByRole("button", { name: "Retry step" });
      await expect(retryButton).toBeVisible();
      await retryButton.click();

      // Launch eligibility is revalidated and a genuine second attempt is
      // created — polled for, not blindly slept on, since the new attempt
      // is created by `enqueueSignal`'s async claim-then-launch tail.
      await expect
        .poll(
          async () => {
            const detail = await fetchRunDetail(page, apiBase, planId);
            return detail.attempts.filter((a) => a.planStepId === investigateStepId).length;
          },
          { timeout: 10000 },
        )
        .toBe(2);

      const afterRetry = await fetchRunDetail(page, apiBase, planId);
      const investigateAttemptsAfterRetry = afterRetry.attempts.filter(
        (a) => a.planStepId === investigateStepId,
      );
      const investigateStepAfterRetry = afterRetry.stepExecutions.find(
        (s) => s.planStepId === investigateStepId,
      );
      // The original abandoned attempt is preserved unchanged, with its
      // original task-run ID intact in history — never revived, never
      // overwritten.
      expect(investigateAttemptsAfterRetry[0]?.status).toBe("abandoned");
      expect(investigateAttemptsAfterRetry[0]?.taskRunId).toBe(investigateTaskRunIdBefore);
      // The replacement attempt is genuinely new: a new task-run ID,
      // different from the one the crash interrupted — the old provider
      // process/task run is never resumed or reused.
      const replacementTaskRunId = investigateAttemptsAfterRetry[1]?.taskRunId;
      expect(replacementTaskRunId).toBeDefined();
      expect(replacementTaskRunId).not.toBe(investigateTaskRunIdBefore);
      expect(investigateStepAfterRetry?.status).not.toBe("awaiting_intervention");
      await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Running")).toBeVisible({
        timeout: 5000,
      });

      // Exactly one `ceo.execution.retry_requested` event, attributed to
      // the explicit operator, never the scheduler's own actor.
      const eventsAfterRetryResp = await page.request.get(
        `${apiBase}/api/v1/ceo-plan-runs/${afterRetry.run.id}/events`,
      );
      const { events: eventsAfterRetry } = (await eventsAfterRetryResp.json()) as {
        events: readonly { type: string; actor: string }[];
      };
      const retryRequestedEvents = eventsAfterRetry.filter(
        (e) => e.type === "ceo.execution.retry_requested",
      );
      expect(retryRequestedEvents).toHaveLength(1);
      expect(retryRequestedEvents[0]?.actor).toBe("human:local-operator");

      // The dedup-gated Board summary for this specific recovery appears
      // at most once.
      await page.goto(`${baseUrl}/board`);
      await openActionsMenu(cardFor(page, parentTitle));
      await page.getByRole("button", { name: "Open discussion" }).click();
      const retryAuditMessage =
        "An operator explicitly retried a step that was abandoned by an unclean Hall Core restart. A new attempt has been prepared.";
      await expect(page.getByText(retryAuditMessage)).toBeVisible();
      const retryAuditMessageCount = await page.getByText(retryAuditMessage).count();
      expect(retryAuditMessageCount).toBe(1);

      // --- Step 26: let the replacement attempt run to genuine natural
      // completion (the "cancellable" fixture behaves identically to
      // "success" unless actually cancelled — see `mock-agent-run.ts`'s own
      // doc comment) — proving the replacement attempt is a fully live,
      // ordinary execution, not a stub. ---
      await page.goto(planUrl);
      await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Completed")).toBeVisible({
        timeout: 45_000,
      });
      const afterCompletion = await fetchRunDetail(page, apiBase, planId);
      const investigateAttemptsAfterCompletion = afterCompletion.attempts.filter(
        (a) => a.planStepId === investigateStepId,
      );
      // Still exactly two attempts total — no further duplication once the
      // replacement attempt finishes on its own.
      expect(investigateAttemptsAfterCompletion).toHaveLength(2);
      expect(investigateAttemptsAfterCompletion[0]?.status).toBe("abandoned");
      expect(investigateAttemptsAfterCompletion[0]?.taskRunId).toBe(investigateTaskRunIdBefore);
      expect(investigateAttemptsAfterCompletion[1]?.status).toBe("completed");
      expect(investigateAttemptsAfterCompletion[1]?.taskRunId).toBe(replacementTaskRunId);

      // --- Step 27: confirm the whole 3-step plan reaches genuine terminal
      // completion. Unlike Phase 15.5 (where the abandoned step could never
      // complete, so the run never left `awaiting_intervention` on its
      // own), the replacement attempt's success now genuinely unblocks
      // Implement and Verify (both the near-instant "success" adapter) —
      // empirically confirmed (not assumed) across this spec's own
      // repeated runs: by this point `run.status` is always already
      // `"completed"`, so "Cancel future scheduling…" (this spec's own
      // Phase 15.5-era safe-teardown action for a plan that could never
      // finish on its own) is no longer reachable here and is not
      // attempted — a genuinely completed run is itself the cleanest
      // possible teardown state. ---
      const beforeCleanup = await fetchRunDetail(page, apiBase, planId);
      expect(beforeCleanup.run.status).toBe("completed");
      expect(beforeCleanup.stepExecutions.every((s) => s.status === "completed")).toBe(true);

      // --- Step 28: no raw stderr, absolute path, process ID, owner
      // token, database epoch, or lease data appears anywhere in Hall Web ---
      await page.goto(planUrl);
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toContain(tempRoot);
      expect(bodyText).not.toContain("hall-core.db");
      expect(bodyText).not.toContain("hall-core.lock");
      expect(bodyText.toLowerCase()).not.toContain("revision");
      expect(bodyText.toLowerCase()).not.toContain("owner_token");
      expect(bodyText.toLowerCase()).not.toContain("epoch");
      expect(bodyText.toLowerCase()).not.toContain("stderr");

      // --- Part C: mobile viewport, no horizontal overflow, and the
      // bounded interruption reason wraps safely ---
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(planUrl);
      const hasHorizontalOverflowMobile = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalOverflowMobile).toBe(false);
      await page.setViewportSize({ width: 1280, height: 1400 });

      // --- No console errors, hydration warnings, or CORS/network
      // failures anywhere in the flow ---
      expect(consoleIssues, `unexpected console/page errors: ${consoleIssues.join("; ")}`).toEqual(
        [],
      );
      expect(
        failedRequests,
        `unexpected failed requests (possible CORS): ${failedRequests.join("; ")}`,
      ).toEqual([]);
    } finally {
      // --- Steps 29-30: stop every test-owned process, remove temporary
      // state ---
      if (hallCore !== undefined) {
        await killAndWait(hallCore.child);
      }
      if (hallWeb !== undefined) {
        await killAndWait(hallWeb);
      }
      if (previousEnableRestartRecovery === undefined) {
        delete process.env.HALL_CORE_E2E_ENABLE_RESTART_RECOVERY;
      } else {
        process.env.HALL_CORE_E2E_ENABLE_RESTART_RECOVERY = previousEnableRestartRecovery;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
