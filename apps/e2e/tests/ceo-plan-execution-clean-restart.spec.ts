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
  CLEAN_RESTART_EXECUTION_HALL_CORE_PORT,
  CLEAN_RESTART_EXECUTION_WEB_PORT,
} from "../src/durable-restart-constants.js";
import { E2E_SOURCE_REPO_RELATIVE_DIR } from "../src/fixture-constants.js";

/**
 * Phase 15.5 — genuine, browser-driven clean-restart verification for
 * autonomous CEO plan EXECUTION (not just plan editing/delegation, which
 * `ceo-plans-durable-restart.spec.ts` already covers against the real
 * production binary). Deliberately independent of the shared suite,
 * spawning its own real `dist/fixture-server.js` process
 * (`spawnDurableFixtureHallCore`) and its own real Hall Web dev server, on
 * dedicated ports — the fixture composition is required here (not the
 * real production binary) because only it can register the deterministic,
 * scriptable "CEO Execution Fixture" adapters this spec's retry/dependency
 * proof needs; see `durable-restart.spec.ts`'s own doc comment for why the
 * production binary can't do this.
 *
 * **Why the "one step complete, one step safely pending, one step
 * genuinely unstarted" snapshot uses a parked retry, not a paused task**:
 * `runRestartRecovery`'s own doc comment (`reconcile-tasks.ts`) is explicit
 * that task-level crash reconciliation runs UNCONDITIONALLY on every boot,
 * clean or not — so any task genuinely `"running"` at the moment Hall Core
 * A stops would be marked interrupted/failed on the next boot regardless
 * of how gracefully that boot was reached, which would make this spec
 * indistinguishable from an unclean-restart one. A step parked in
 * `retry_wait` has no active task at all (the failed attempt is already
 * terminal) — nothing for reconciliation to touch — and resumes with
 * ZERO operator action once its durable backoff elapses, which is exactly
 * what "the next eligible step continues automatically" requires. This
 * mirrors an already-proven unit contract:
 * `ceo-plan-execution-durable-restart.test.ts`'s "clean restart: a
 * retry_wait step is left untouched — same status, same nextEligibleAt,
 * never force-reset or silently abandoned" — this spec is its browser-level
 * counterpart. The retry backoff is set to 25s specifically so the parked
 * retry is still genuinely pending across state capture, the graceful
 * stop, and the restart — the wait for it to fire afterward is real
 * elapsed server time being proven, not a sleep masking a race (same
 * justification `ceo-plan-execution-retry-circuit.spec.ts` already
 * documents for its own `RETRY_BACKOFF_SECONDS`).
 *
 * **`HALL_CORE_E2E_ENABLE_RESTART_RECOVERY`**: opts this spec's fixture
 * Hall Core into the REAL Phase 13 crash-vs-clean classification
 * (`runRestartRecovery`) instead of the hardcoded `"first_start"` every
 * other fixture-composition spec relies on — see `fixture-server.ts`'s own
 * doc comment. Needed so the `/system` page genuinely reports "Clean" on
 * the second boot (not "First startup" again), and so this spec is a real
 * proof of the crash-detection path finding nothing to reconcile, not an
 * assumption that it would.
 *
 * **IMPORTANT — stale dist**: like every durable-restart spec, this one
 * runs the actually-compiled `apps/server/dist/*` and `apps/e2e/dist/*`
 * output, never the TypeScript source directly. Before running this spec
 * (or any complete Playwright batch that includes it), rebuild both:
 * `pnpm --filter @hall-of-wisdom/hall-core run build` and
 * `pnpm --filter @hall-of-wisdom/e2e run build` — a stale dist silently
 * re-tests old behavior instead of failing loudly. See
 * `docs/architecture/0015-autonomous-plan-execution-and-scheduling.md`'s
 * "Operational note" for the real session this was discovered in.
 */

const RETRY_BACKOFF_SECONDS = 25;

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
  await page.getByLabel("Project").fill("clean-restart-execution-e2e");
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
    readonly planVersion: number;
    readonly policySnapshot: {
      readonly maxAttemptsPerStep: number;
      readonly retryBackoffSeconds: number;
      readonly maxConsecutiveFailures: number;
    };
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

async function fetchEventCount(page: Page, apiBase: string, runId: string): Promise<number> {
  const resp = await page.request.get(`${apiBase}/api/v1/ceo-plan-runs/${runId}/events`);
  const { events } = (await resp.json()) as { events: readonly { sequence: number }[] };
  return events.length;
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

test.describe("CEO plan execution — clean browser restart (Phase 15.5)", () => {
  test("a completed step, a parked retry, and a dependency-blocked step all survive a graceful Hall Core restart, and the parked retry resumes and finishes with zero operator action", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    requireDualFixtureDurableRestartBuildArtifacts();

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-clean-restart-execution-e2e-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    const dataDir = path.join(tempRoot, "data");
    const comparisonRoot = path.join(tempRoot, "comparisons");
    // Deliberately NOT pre-initialized here — unlike
    // `ceo-plans-durable-restart.spec.ts` (which spawns the real
    // production binary, which never creates a workspace on its own),
    // `fixture-server.ts`'s own `main()` initializes `workspaceRoot` and
    // its nested source repo itself, exactly once, the first time it sees
    // no `.git` there — matching `dual-fixture-durable-restart.spec.ts`'s
    // identical setup.
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(comparisonRoot, { recursive: true });

    const baseUrl = `http://127.0.0.1:${String(CLEAN_RESTART_EXECUTION_WEB_PORT)}`;
    const apiBase = `http://127.0.0.1:${String(CLEAN_RESTART_EXECUTION_HALL_CORE_PORT)}`;
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
      // --- Steps 1-2: start durable fixture Hall Core A, Hall Web ---
      hallCore = spawnDurableFixtureHallCore({
        workspaceRoot,
        dataDir,
        comparisonRoot,
        port: CLEAN_RESTART_EXECUTION_HALL_CORE_PORT,
        webPort: CLEAN_RESTART_EXECUTION_WEB_PORT,
      });
      await waitForHallCoreHealth(hallCore.port);
      hallWeb = spawnDurableHallWeb(hallCore.port, CLEAN_RESTART_EXECUTION_WEB_PORT);
      await waitForHallWebReady(CLEAN_RESTART_EXECUTION_WEB_PORT);

      // --- Step 3: open the real browser ---
      await page.goto(`${baseUrl}/system`);
      await expect(page.getByText("Durable")).toBeVisible();
      await expect(page.getByText("First startup")).toBeVisible();

      // --- Steps 4-9: parent task, deterministic plan, approve, delegate,
      // confirm children assigned but unstarted ---
      const { planUrl, investigateTitle, implementTitle, verifyTitle } = await delegateFreshPlan(
        page,
        baseUrl,
        "Clean restart execution",
      );
      await expect(cardFor(page, investigateTitle)).toContainText("Assigned");
      await expect(cardFor(page, investigateTitle)).toContainText("0 events");

      await assignAgent(page, investigateTitle, "CEO Execution Fixture (success)");
      await assignAgent(
        page,
        implementTitle,
        "CEO Execution Fixture (transient once, then success)",
      );
      await assignAgent(page, verifyTitle, "CEO Execution Fixture (success)");

      // --- Steps 10-12: configure autonomous execution, explicitly
      // authorize, start ---
      await page.goto(planUrl);
      const planId = extractPlanId(planUrl);
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

      // --- Step 13: allow Investigate to complete; Implement's one
      // transient failure parks it in retry_wait (a safe, no-active-task
      // state — see this file's own doc comment); Verify stays blocked ---
      await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Completed")).toBeVisible({
        timeout: 20000,
      });
      await expect(
        stepStatus(page, /^Step 2: Implement:/).getByText("Waiting to retry"),
      ).toBeVisible({ timeout: 20000 });
      await expect(stepRow(page, /^Step 2: Implement:/).getByText(/Attempts: 1/)).toBeVisible();
      await expect(
        stepStatus(page, /^Step 3: Verify:/).getByText("Waiting on dependencies"),
      ).toBeVisible();

      // --- Step 15: capture full pre-restart state through REST and UI ---
      const before = await fetchRunDetail(page, apiBase, planId);
      expect(before.run.status).toBe("running");
      // Step 14, verified: no step execution is in an active-task state.
      for (const step of before.stepExecutions) {
        expect(["claimed", "starting", "running"]).not.toContain(step.status);
      }
      const implementStepId = await findStepIdByTaskTitle(page, apiBase, before, implementTitle);
      const investigateStepId = await findStepIdByTaskTitle(
        page,
        apiBase,
        before,
        investigateTitle,
      );
      const implementAttemptsBefore = before.attempts.filter(
        (a) => a.planStepId === implementStepId,
      );
      expect(implementAttemptsBefore).toHaveLength(1);
      const implementAttempt1 = implementAttemptsBefore[0];
      const investigateStepBefore = before.stepExecutions.find(
        (s) => s.planStepId === investigateStepId,
      );
      const investigateTaskId = investigateStepBefore?.childTaskId;
      const tasksBeforeResp = await page.request.get(`${apiBase}/api/v1/tasks`);
      const { tasks: tasksBefore } = (await tasksBeforeResp.json()) as {
        tasks: readonly { readonly task: { readonly taskId: string; readonly status: string } }[];
      };
      const investigateTaskBefore = tasksBefore.find((t) => t.task.taskId === investigateTaskId);
      expect(investigateTaskBefore?.task.status).toBe("completed");
      const eventCountBefore = await fetchEventCount(page, apiBase, before.run.id);
      expect(eventCountBefore).toBeGreaterThan(0);

      // --- Step 16: stop Hall Core A through its normal controlled
      // shutdown path; Hall Web/browser stay open ---
      // --- Step 18: confirm Hall Web visibly enters an
      // offline/reconnecting state — checked via the execution section's
      // OWN WebSocket connection indicator (`ConnectionStatus`), which
      // notices the drop and starts reconnecting on its own, with no
      // reload — the general `/system` "Hall Core: Offline" banner only
      // re-checks on an explicit poll/reload and isn't the right signal
      // for "reconnects without a page reload" (step 21). ---
      const executionSection = page.getByRole("region", { name: "Autonomous execution" });
      hallCoreExpectedDown = true;
      await hallCore.gracefulStop();
      await expect(
        executionSection.getByText(/Reconnecting|Disconnected|Stream error/),
      ).toBeVisible({ timeout: 15_000 });

      // --- Step 19: no browser mutation falsely reports success while
      // offline — attempting a real mutation must fail visibly, not
      // silently succeed ---
      const offlineRetryResp = await page.request
        .post(`${apiBase}/api/v1/ceo-plan-runs/${before.run.id}/pause`, {
          data: { actor: undefined },
          failOnStatusCode: false,
          timeout: 3000,
        })
        .catch(() => undefined);
      expect(offlineRetryResp).toBeUndefined();

      // --- Step 20: start Hall Core B with the exact same dataDir/
      // workspaceRoot/comparisonRoot/configuration fingerprint ---
      hallCore = spawnDurableFixtureHallCore({
        workspaceRoot,
        dataDir,
        comparisonRoot,
        port: CLEAN_RESTART_EXECUTION_HALL_CORE_PORT,
        webPort: CLEAN_RESTART_EXECUTION_WEB_PORT,
      });
      await waitForHallCoreHealth(hallCore.port);
      hallCoreExpectedDown = false;

      // --- Step 21: Hall Web reconnects without a page reload — the same
      // WebSocket indicator recovers to "Live" on its own ---
      await expect(executionSection.getByText("Live", { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      // --- Step 29 (checked here, right after reconnect, before anything
      // else can run): /system now genuinely reports Clean, not First
      // startup again — real crash-classification evidence, not assumed.
      // A real navigation (not the reload this spec deliberately avoided
      // above), on a different page whose own health poll only refreshes
      // periodically. ---
      await page.goto(`${baseUrl}/system`);
      await expect(page.getByText("Clean", { exact: true })).toBeVisible();

      // --- Steps 22-23: run/policy/version/step state restored intact,
      // immediately (before the retry backoff elapses) ---
      const afterRestart = await fetchRunDetail(page, apiBase, planId);
      expect(afterRestart.run.id).toBe(before.run.id);
      expect(afterRestart.run.planVersion).toBe(before.run.planVersion);
      expect(afterRestart.run.policySnapshot).toEqual(before.run.policySnapshot);
      const investigateStepAfter = afterRestart.stepExecutions.find(
        (s) => s.planStepId === investigateStepId,
      );
      expect(investigateStepAfter?.status).toBe("completed");
      const implementStepAfter = afterRestart.stepExecutions.find(
        (s) => s.planStepId === implementStepId,
      );
      expect(implementStepAfter?.status).toBe("retry_wait");
      const implementAttemptsAfterRestart = afterRestart.attempts.filter(
        (a) => a.planStepId === implementStepId,
      );
      // No duplicate/second attempt yet — restart alone never launches
      // anything on its own, only the durable wake timer firing does.
      expect(implementAttemptsAfterRestart).toHaveLength(1);
      expect(implementAttemptsAfterRestart[0]?.id).toBe(implementAttempt1?.id);
      expect(implementAttemptsAfterRestart[0]?.taskRunId).toBe(implementAttempt1?.taskRunId);

      const tasksAfterResp = await page.request.get(`${apiBase}/api/v1/tasks`);
      const { tasks: tasksAfter } = (await tasksAfterResp.json()) as {
        tasks: readonly { readonly task: { readonly taskId: string; readonly status: string } }[];
      };
      const investigateTaskAfter = tasksAfter.find((t) => t.task.taskId === investigateTaskId);
      expect(investigateTaskAfter?.task.status).toBe("completed");

      const eventCountAfterRestart = await fetchEventCount(page, apiBase, before.run.id);
      expect(eventCountAfterRestart).toBe(eventCountBefore);

      await page.goto(planUrl);
      await expect(stepStatus(page, /^Step 1: Investigate:/).getByText("Completed")).toBeVisible();
      await expect(stepRow(page, /^Step 2: Implement:/).getByText(/Attempts: 1/)).toBeVisible();

      // --- Step 24: the parked retry fires on its own, zero operator
      // action — real elapsed server time, not a synchronization hack ---
      await page.waitForTimeout(RETRY_BACKOFF_SECONDS * 1000 + 3000);
      await expect(stepRow(page, /^Step 2: Implement:/).getByText(/Attempts: 2/)).toBeVisible({
        timeout: 10000,
      });
      const afterRetry = await fetchRunDetail(page, apiBase, planId);
      const implementAttemptsAfterRetry = afterRetry.attempts.filter(
        (a) => a.planStepId === implementStepId,
      );
      expect(implementAttemptsAfterRetry).toHaveLength(2);
      const implementAttempt2 = implementAttemptsAfterRetry.find(
        (a) => a.id !== implementAttempt1?.id,
      );
      expect(implementAttempt2?.taskRunId).toBeDefined();
      expect(implementAttempt2?.taskRunId).not.toBe(implementAttempt1?.taskRunId);

      // --- Steps 25-26: Verify continues automatically once Implement's
      // dependency clears — zero operator action — and the plan reaches
      // completed exactly once. Verify's own step badge is checked, never
      // a bare "Completed" text search — Investigate's identical badge
      // has already been showing "Completed" since long before this
      // point, which would make an unscoped search pass immediately
      // without ever proving the run itself finished. ---
      await expect(stepStatus(page, /^Step 3: Verify:/).getByText("Completed")).toBeVisible({
        timeout: 20000,
      });
      await expect
        .poll(async () => (await fetchRunDetail(page, apiBase, planId)).run.status, {
          timeout: 10000,
        })
        .toBe("completed");
      const final = await fetchRunDetail(page, apiBase, planId);
      expect(final.run.status).toBe("completed");
      for (const step of final.stepExecutions) {
        expect(step.status).toBe("completed");
      }

      // --- Step 27: exactly one terminal execution event ---
      const eventsResp = await page.request.get(
        `${apiBase}/api/v1/ceo-plan-runs/${final.run.id}/events`,
      );
      const { events } = (await eventsResp.json()) as {
        events: readonly { type: string }[];
      };
      expect(events.filter((e) => e.type === "ceo.execution.completed")).toHaveLength(1);
      expect(events.filter((e) => e.type === "ceo.execution.step_completed")).toHaveLength(3);

      // --- Step 28: exactly one plan-completion Board summary, on the
      // PARENT task's own board ---
      const parentTitle = investigateTitle.replace(/^Investigate: /, "");
      await page.goto(`${baseUrl}/board`);
      await openActionsMenu(cardFor(page, parentTitle));
      await page.getByRole("button", { name: "Open discussion" }).click();
      await expect(page.getByText("Autonomous execution completed successfully.")).toBeVisible();
      const completionMessages = await page
        .getByText("Autonomous execution completed successfully.")
        .count();
      expect(completionMessages).toBe(1);

      // --- Step 29: no real Claude Code/Codex process was ever started —
      // structurally guaranteed: this fixture composition never registers
      // either, so nothing on this page could have come from one. ---

      // --- Part C: mobile viewport, no horizontal overflow ---
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(planUrl);
      const hasHorizontalOverflowMobile = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalOverflowMobile).toBe(false);
      await page.goto(`${baseUrl}/board`);
      const hasHorizontalOverflowBoard = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalOverflowBoard).toBe(false);
      await page.setViewportSize({ width: 1280, height: 1400 });

      // --- No internal identifier ever leaks into the rendered DOM ---
      await page.goto(planUrl);
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toContain(tempRoot);
      expect(bodyText).not.toContain("hall-core.db");
      expect(bodyText).not.toContain("hall-core.lock");
      expect(bodyText.toLowerCase()).not.toContain("revision");

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
      // --- Steps 30-31: stop every test-owned process, remove temporary
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
