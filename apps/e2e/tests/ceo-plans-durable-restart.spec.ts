import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import {
  killAndWait,
  requireDurableRestartBuildArtifacts,
  spawnDurableHallCore,
  spawnDurableHallWeb,
  waitForHallCoreHealth,
  waitForHallWebReady,
  type SpawnedHallCore,
} from "../src/durable-restart-harness.js";
import {
  CEO_PLANS_DURABLE_RESTART_HALL_CORE_PORT,
  CEO_PLANS_DURABLE_RESTART_WEB_PORT,
} from "../src/durable-restart-constants.js";

/**
 * Phase 14.1 — genuine, browser-driven durable restart verification for
 * the CEO plan editing/delegation workflow. Deliberately independent of
 * the shared suite, mirroring `durable-restart.spec.ts`'s own
 * dedicated-real-binary pattern: its own real built Hall Core binary, its
 * own real Hall Web dev server, on their own ports
 * (CEO_PLANS_DURABLE_RESTART_HALL_CORE_PORT/_WEB_PORT), entirely outside
 * Playwright's shared `webServer` config. Fixture adapters only — Mock
 * Agent (`--mock-scenario success`), never a real Claude Code or Codex
 * execution, matching every other durable-restart spec in this
 * repository.
 *
 * **Adapter-selector scope, disclosed rather than silently narrowed**: the
 * only way to give a CEO-planned step real, persisted `requirements`
 * through genuine UI navigation is to route and assign the parent task
 * first (the plain backlog form has no requirements field). Using the
 * "Simulation / testing" profile — the only profile whose recommended
 * adapter can actually start and complete without a real provider — means
 * every step's `allowedExecutionTrust` is `["simulated"]`, and Mock Agent
 * is the *only* adapter in this codebase that ever reports
 * `executionTrust: "simulated"` (see `descriptor.ts`). So the per-step
 * adapter selector this spec drives always has exactly one *eligible*
 * candidate, already checked (it's the recommendation) — clicking its
 * radio (the "explicit adapter confirmation" this spec exercises) fires no
 * `change` event at all, per the HTML radio-input contract for clicking an
 * already-checked control, so `selectedAdapterId` simply stays whatever it
 * already was (`undefined`, since a freshly-planned step never has one).
 * This spec therefore verifies the selector's real rendering and click
 * interaction (recommended candidate shown, checked, and clicked) and that
 * the resulting saved version still carries `recommendedAdapterId`
 * correctly — not a persisted cross-restart *override*, which would
 * require a second `simulated`-trust adapter that does not exist in the
 * real production binary. Exactly the same class of disclosed scope
 * narrowing `durable-restart.spec.ts` itself uses for its own candidate-B
 * limitation.
 *
 * **"Both versions survive restart," precisely**: `CeoPlanDetail` only
 * ever fetches and renders the plan's current `activeVersion` — there is
 * no UI route to view a superseded version's own step content directly.
 * "Both versions survive" is therefore verified the way an operator would
 * actually observe it in the browser: the Activity log still lists both
 * the `ceo.plan.created` (version 1) and `ceo.plan.version_created`
 * (version 2) events after restart, and the approval history still
 * correctly attributes the approval to version 2 specifically — proving
 * the durable store's multi-version bookkeeping, not a content-retrieval
 * capability the product doesn't have.
 *
 * **`progress_changed` count, precisely**: delegation's own reconciliation
 * pass and the dependency-free child's assigned→running edge each already
 * produce one real, correct `progress_changed` event before that child
 * even completes — the fingerprint guard (Task 6) only collapses repeated
 * notifications for the *same* resulting progress state, it does not
 * collapse genuinely distinct transitions into one. So this spec does not
 * assert a fixed event count; it asserts what the guard actually promises:
 * the count settles once the run completes, and a reload never moves it
 * further.
 */

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function initRepoWithCommit(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  git(["init", "--quiet"], repoPath);
  git(["config", "user.email", "hall-of-wisdom-e2e@example.com"], repoPath);
  git(["config", "user.name", "Hall of Wisdom E2E"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "ceo plans durable restart e2e fixture\n");
  git(["add", "README.md"], repoPath);
  git(["commit", "--quiet", "-m", "initial commit"], repoPath);
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

test.describe("CEO plans durable browser restart (Phase 14.1)", () => {
  test("editing a plan into a new version, approving and delegating it, and restarting Hall Core mid-session leaves every piece of plan state intact", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    requireDurableRestartBuildArtifacts();

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-ceo-plans-durable-restart-e2e-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    const dataDir = path.join(tempRoot, "data");
    const sourceRepoRelativeDir = "source-repo";
    fs.mkdirSync(workspaceRoot, { recursive: true });
    initRepoWithCommit(path.join(workspaceRoot, sourceRepoRelativeDir));

    const baseUrl = `http://127.0.0.1:${String(CEO_PLANS_DURABLE_RESTART_WEB_PORT)}`;
    let hallCore: SpawnedHallCore | undefined;
    let hallWeb: ChildProcess | undefined;

    // Collected throughout, asserted once at the end — see
    // `durable-restart.spec.ts`'s identical pattern and its explanation of
    // why `hallCoreExpectedDown` narrows only the one class of error this
    // spec deliberately provokes.
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

    try {
      // --- Start Hall Core A (durable) and Hall Web ---
      hallCore = spawnDurableHallCore({
        workspaceRoot,
        dataDir,
        port: CEO_PLANS_DURABLE_RESTART_HALL_CORE_PORT,
        webPort: CEO_PLANS_DURABLE_RESTART_WEB_PORT,
      });
      await waitForHallCoreHealth(hallCore.port);
      hallWeb = spawnDurableHallWeb(hallCore.port, CEO_PLANS_DURABLE_RESTART_WEB_PORT);
      await waitForHallWebReady(CEO_PLANS_DURABLE_RESTART_WEB_PORT);

      // --- Create, route, and assign the parent task (Simulation / testing profile) ---
      await page.goto(`${baseUrl}/board`);
      // Deliberately does not contain the substring "CEO plans" — Playwright's
      // `getByRole` name matching is substring-based by default, and that
      // exact string is also an actions-menu button's own accessible name,
      // which would make every later `getByRole("button", { name: "CEO
      // plans" })` lookup ambiguous against this task's own Kanban card.
      const title = `Durable restart CEO workflow e2e ${Date.now().toString()}`;
      await page.getByRole("button", { name: "+ New backlog task" }).click();
      await page.getByLabel("Project").fill("ceo-plans-durable-restart-e2e");
      await page.getByLabel("Title").fill(title);
      await page
        .getByLabel("Description")
        .fill("Add a health-check endpoint that reports database connectivity.");
      await page.getByLabel("Working directory (optional, relative)").fill(sourceRepoRelativeDir);
      await page.getByRole("button", { name: "Add to Backlog" }).click();
      const card = cardFor(page, title);
      await expect(card).toBeVisible();

      await openActionsMenu(card);
      await page.getByRole("button", { name: "Move to Ready" }).click();
      await expect(card.getByText("Ready", { exact: true })).toBeVisible();
      await openActionsMenu(card);
      await page.getByRole("button", { name: "Find suitable agent" }).click();
      const routingDialog = page.getByRole("dialog", { name: /Find suitable agent/ });
      await expect(routingDialog).toBeVisible();
      await routingDialog
        .getByLabel("Requirement profile")
        .selectOption({ label: "Simulation / testing" });
      await expect(routingDialog.getByText(/Recommended "Mock Agent"/)).toBeVisible();
      await routingDialog.getByRole("button", { name: "Route and assign" }).click();
      await expect(card.getByText("Assigned", { exact: true })).toBeVisible();

      // --- Create the draft plan (version 1) ---
      await openActionsMenu(card);
      await page.getByRole("button", { name: "CEO plans" }).click();
      await expect(page).toHaveURL(/\/ceo\?parentTaskId=/);
      await page.getByRole("button", { name: "Ask CEO to plan" }).click();
      await page.getByRole("button", { name: "Create draft plan" }).click();
      await expect(page).toHaveURL(/\/ceo\/[^/?]+$/);
      const planUrl = page.url();
      await expect(page.getByText("Draft", { exact: true })).toBeVisible();
      await expect(page.getByText("Steps (3)")).toBeVisible();

      // --- Edit into version 2: open the form, confirm the adapter selector, save ---
      await page.getByRole("button", { name: "Edit plan…" }).click();
      const editDialog = page.getByRole("dialog", { name: "Edit plan — save as new version" });
      await expect(editDialog).toBeVisible();
      const adapterRadio = editDialog.getByLabel("Mock Agent (hall.mock-agent)").first();
      await expect(adapterRadio).toBeChecked();
      await expect(editDialog.getByText(/· Recommended/).first()).toBeVisible();
      // The explicit confirmation click this spec's file-level doc comment
      // describes: a real mouse click dispatched through Playwright at the
      // already-checked, already-recommended radio. Per the HTML radio
      // input contract, clicking an already-checked radio fires no
      // `change` event at all (not merely one whose value maps back to
      // "no override") — so this asserts the operator-visible state
      // (checked, annotated "Recommended") rather than an `onChange` call
      // that structurally cannot happen here.
      await adapterRadio.click();
      await expect(adapterRadio).toBeChecked();
      await editDialog.getByRole("button", { name: "Save as new version" }).click();
      await expect(editDialog).not.toBeVisible();
      await expect(page.getByText("New plan version saved.")).toBeVisible();
      await expect(
        page.locator("dt", { hasText: "Active version" }).locator("..").locator("dd"),
      ).toHaveText("2");

      // --- Approve version 2, then delegate it ---
      await page.getByRole("button", { name: "Submit for approval" }).click();
      await expect(page.getByText("Awaiting approval", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Approve…" }).click();
      const approveDialog = page.getByRole("dialog", { name: /Approve plan version 2/ });
      await expect(approveDialog).toBeVisible();
      await expect(approveDialog.getByText("hall.mock-agent (simulated)")).toHaveCount(3);
      await approveDialog.getByRole("checkbox").check();
      await approveDialog.getByRole("button", { name: "Approve plan" }).click();
      await expect(approveDialog).not.toBeVisible();
      await expect(page.getByText("Approved", { exact: true })).toBeVisible();
      // Approval alone starts nothing — the required Phase 14 invariant,
      // re-verified here specifically for a plan reached via the edit
      // flow rather than a first-draft submission.
      await page.goto(`${baseUrl}/board`);
      await expect(cardFor(page, `Investigate: ${title}`)).toHaveCount(0);
      await page.goto(planUrl);
      await expect(page.getByText("Approved", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Delegate…" }).click();
      const delegateDialog = page.getByRole("dialog");
      await expect(delegateDialog).toBeVisible();
      await delegateDialog.getByRole("checkbox").check();
      await delegateDialog.getByRole("button", { name: "Delegate" }).click();
      await expect(delegateDialog.getByText(/Delegated — 3 child tasks created/)).toBeVisible();
      await delegateDialog.getByRole("link", { name: "Go to Kanban board" }).click();
      await expect(page).toHaveURL(/\/board$/);

      const investigateCard = cardFor(page, `Investigate: ${title}`);
      const implementCard = cardFor(page, `Implement: ${title}`);
      const verifyCard = cardFor(page, `Verify: ${title}`);
      await expect(investigateCard).toContainText("Assigned");
      await expect(implementCard).toContainText("Assigned");
      await expect(verifyCard).toContainText("Assigned");
      await expect(investigateCard.getByRole("button", { name: "Start task" })).toBeVisible();
      await expect(implementCard.getByRole("button", { name: "Start task" })).toBeVisible();

      // --- Dependency readiness reflected on the plan page before any child starts ---
      await page.goto(planUrl);
      await expect(page.getByText("Ready to start")).toHaveCount(1);
      await expect(page.getByText("Waiting on dependencies")).toHaveCount(2);

      // --- Stop Hall Core A gracefully; Hall Web/browser stay open ---
      hallCoreExpectedDown = true;
      await hallCore.gracefulStop();
      await page.goto(`${baseUrl}/system`);
      await expect(page.getByText("Hall Core: Offline")).toBeVisible({ timeout: 10_000 });

      // --- Start Hall Core B with the same dataDir/workspaceRoot ---
      hallCore = spawnDurableHallCore({
        workspaceRoot,
        dataDir,
        port: CEO_PLANS_DURABLE_RESTART_HALL_CORE_PORT,
        webPort: CEO_PLANS_DURABLE_RESTART_WEB_PORT,
      });
      await waitForHallCoreHealth(hallCore.port);
      hallCoreExpectedDown = false;
      await page.reload();
      await expect(page.getByText("Hall Core: Online")).toBeVisible({ timeout: 10_000 });

      // --- Plan/version/approval/delegation bookkeeping survives ---
      await page.goto(planUrl);
      await expect(page.getByText("Approved", { exact: true })).not.toBeVisible();
      // Delegation already happened before the restart, so the plan is
      // now `delegated` — re-fetched fresh from the restarted Hall Core.
      // `.first()` — the status badge, not the summary `dl`'s own
      // "Delegated" timestamp label, which also matches this text exactly
      // once `plan.delegatedAt` is set, but renders later in the DOM.
      await expect(page.getByText("Delegated", { exact: true }).first()).toBeVisible();
      await expect(page.getByText(/Version 2 — approve/)).toBeVisible();
      await expect(page.getByText(/Version 1 —/)).toHaveCount(0);
      await expect(page.getByText("ceo.plan.created")).toHaveCount(1);
      await expect(page.getByText("ceo.plan.version_created")).toHaveCount(1);
      await expect(page.getByText("ceo.plan.approved")).toHaveCount(1);
      await expect(page.getByText("ceo.plan.delegated")).toHaveCount(1);
      await expect(page.getByText("Depends on 1 earlier step")).toHaveCount(2);

      await page.goto(`${baseUrl}/board`);
      const investigateCardAfterRestart = cardFor(page, `Investigate: ${title}`);
      const implementCardAfterRestart = cardFor(page, `Implement: ${title}`);
      const verifyCardAfterRestart = cardFor(page, `Verify: ${title}`);
      await expect(investigateCardAfterRestart).toContainText("Assigned");
      await expect(implementCardAfterRestart).toContainText("Assigned");
      await expect(verifyCardAfterRestart).toContainText("Assigned");
      await expect(
        investigateCardAfterRestart.getByText("mock-agent", { exact: true }),
      ).toBeVisible();
      await expect(
        implementCardAfterRestart.getByText("mock-agent", { exact: true }),
      ).toBeVisible();
      await expect(verifyCardAfterRestart.getByText("mock-agent", { exact: true })).toBeVisible();

      // The delegation audit message lives on the PARENT task's own board
      // (`ceo-plan-orchestrator.ts`'s `#postAuditMessage(parentTaskId, ...)`),
      // not any child's — reopen the parent task's card, not one of the
      // three delegated children, to find it.
      await openActionsMenu(cardFor(page, title));
      await page.getByRole("button", { name: "Open discussion" }).click();
      await expect(
        page.getByText(/CEO plan .+ delegated: 3 child task\(s\) created\./),
      ).toBeVisible();
      const delegationMessages = await page
        .getByText(/CEO plan .+ delegated: 3 child task\(s\) created\./)
        .count();
      expect(delegationMessages).toBe(1);

      // --- Start the one dependency-free child; nothing else starts ---
      await page.goto(`${baseUrl}/board`);
      await investigateCardAfterRestart.getByRole("button", { name: "Start task" }).click();
      await investigateCardAfterRestart.getByRole("button", { name: "Confirm" }).click();
      await expect(investigateCardAfterRestart.getByText("Completed", { exact: true })).toBeVisible(
        { timeout: 20_000 },
      );
      await expect(implementCardAfterRestart).toContainText("Assigned");
      await expect(implementCardAfterRestart.getByText("Starting…")).not.toBeVisible();
      await expect(
        implementCardAfterRestart.getByRole("button", { name: "Start task" }),
      ).toBeVisible();
      await expect(verifyCardAfterRestart).toContainText("Assigned");

      // --- A progress_changed-driven update reaches the plan page, and a
      // reload never duplicates it. Delegation's own reconciliation pass
      // and the assigned→running edge each already produce one
      // `progress_changed` event before the run even completes (this is
      // real, correct behavior, not a duplicate — the fingerprint guard
      // only collapses repeated notifications for the *same* resulting
      // state), so the number after completion isn't a fixed constant this
      // spec should hardcode. What the fingerprint guard actually promises
      // — see `ceo-plan-progress-sync.ts` and Task 6's regression coverage
      // — is that re-reading unchanged state never appends another event.
      // That's what's checked here: the count settles once the run
      // completes and a reload never moves it further. ---
      await page.goto(planUrl);
      await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText("Ready to start")).toHaveCount(1);
      await expect(page.getByText("Waiting on dependencies")).toHaveCount(1);
      const progressChangedCount = await page.getByText("ceo.plan.progress_changed").count();
      expect(progressChangedCount).toBeGreaterThan(0);

      // --- Reload produces no duplicate event/message ---
      await page.reload();
      await expect(page.getByText("ceo.plan.progress_changed")).toHaveCount(progressChangedCount);
      await expect(page.getByText("ceo.plan.delegated")).toHaveCount(1);

      // --- No internal identifier ever leaks into the rendered DOM ---
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toContain(tempRoot);
      expect(bodyText).not.toContain("hall-core.db");
      expect(bodyText).not.toContain("hall-core.lock");
      expect(bodyText.toLowerCase()).not.toContain("revision");

      // --- No console errors, hydration warnings, or CORS failures anywhere in the flow ---
      expect(consoleIssues).toEqual([]);
    } finally {
      if (hallCore !== undefined) {
        await killAndWait(hallCore.child);
      }
      if (hallWeb !== undefined) {
        await killAndWait(hallWeb);
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
