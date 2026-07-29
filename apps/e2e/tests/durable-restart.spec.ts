import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import {
  killAndWait,
  requireDurableRestartBuildArtifacts,
  spawnDurableHallCore,
  spawnDurableHallWeb,
  waitForHallCoreHealth,
  waitForHallWebReady,
  type SpawnedHallCore,
} from "../src/durable-restart-harness.js";
import { DURABLE_RESTART_WEB_PORT } from "../src/durable-restart-constants.js";

/**
 * Phase 13.1 — genuine, browser-driven durable restart verification.
 *
 * Deliberately independent of the shared suite: spawns its own real
 * built Hall Core binary and its own real Hall Web dev server, on their
 * own ports, entirely outside Playwright's `webServer` config (see
 * `durable-restart-harness.ts`'s doc comment for why). Fixture adapters
 * only — Mock Agent (`--mock-scenario success`) is this repository's
 * established, deterministic, network-free stand-in wherever a process
 * is spawned for real (matching `apps/server/src/process-tests/**`);
 * never a real Claude Code or Codex execution, and no provider
 * subscription usage anywhere in this spec.
 *
 * **A genuine product constraint found while building this spec, not a
 * shortcut**: the real `dist/server.js` binary always registers exactly
 * three adapters (Mock Agent, Claude Code, Codex) — there is no way,
 * through the real CLI, to register a second Mock-Agent-like adapter
 * whose `startTask()` deterministically completes. `apps/e2e`'s existing
 * `fixture-server.ts` solves this for its own specs by registering two
 * custom completing fixture adapters, but that server is explicitly
 * never reachable through any production CLI flag (see
 * `fixture-constants.ts`) — using it here would mean this spec no longer
 * exercises the actual production binary, which is the entire point of
 * a "durable restart" verification. Compounding that: the real "Compare
 * agents" dialog does not even offer Codex as a selectable option at all
 * in strict mode (its `<option>` is disabled, confirmed empirically
 * while building this spec) — so Codex cannot be a comparison candidate
 * here regardless of whether it's ever started.
 *
 * Given that, this spec's two comparison candidates are **Mock Agent**
 * (candidate A — actually starts and completes, both before the restart
 * and with its result verified surviving it) and **Claude Code**
 * (candidate B — prepared only, via `ComparisonOrchestrator.
 * prepareComparison`'s pure Git worktree creation, which calls no
 * adapter method at all; its "Start" button is never clicked, before or
 * after the restart, so no real Claude Code process is ever spawned).
 * Cleanup requires every candidate to be terminal, so — after re-verifying
 * candidate B is still exactly `Prepared` post-restart — this spec clicks
 * "Cancel" on it (a safe, no-execution action for a not-yet-started
 * candidate) rather than "Start", solely to reach a cleanup-eligible state.
 * This still verifies everything meaningful about comparison restart
 * durability — the comparison, candidate A's completed result and
 * events, the recorded preference, and candidate B's own untouched
 * `prepared` state all survive the restart intact — but candidate B
 * never actually starts or produces a second real event stream in this
 * spec. Documented here and in the final report; not silently
 * substituted for a claim this spec doesn't actually back up.
 *
 * Phase 13.2 — the "candidate B genuinely starts after a durable restart"
 * gap this spec's own doc comment above describes is closed by
 * `dual-fixture-durable-restart.spec.ts`, which uses a dedicated
 * test-infrastructure Hall Core composition (two genuinely-completing
 * fixture adapters, never a production CLI flag) to click Start on both
 * candidates, one before the restart and one after it, and confirms both
 * complete with correctly isolated event streams. That spec is additive
 * to this one, not a replacement — this spec's own value (proving the
 * real production binary's restart durability end to end) is unchanged
 * and still required.
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
  fs.writeFileSync(path.join(repoPath, "README.md"), "durable restart e2e fixture\n");
  git(["add", "README.md"], repoPath);
  git(["commit", "--quiet", "-m", "initial commit"], repoPath);
}

test.describe("Durable browser restart (Phase 13.1)", () => {
  test("state created before a graceful restart is fully intact afterward, through the real browser UI", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    requireDurableRestartBuildArtifacts();

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-durable-restart-e2e-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    const dataDir = path.join(tempRoot, "data");
    const comparisonRoot = path.join(tempRoot, "comparisons");
    const sourceRepoRelativeDir = "source-repo";
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(comparisonRoot, { recursive: true });
    initRepoWithCommit(path.join(workspaceRoot, sourceRepoRelativeDir));

    const baseUrl = `http://127.0.0.1:${String(DURABLE_RESTART_WEB_PORT)}`;
    let hallCore: SpawnedHallCore | undefined;
    let hallWeb: ChildProcess | undefined;

    // Step 34 — collected throughout, asserted once at the end so a
    // single console error anywhere in the flow fails the whole test
    // rather than being silently missed. `hallCoreExpectedDown` narrows
    // the one class of error this spec deliberately provokes (steps
    // 15–17's real outage window) so it doesn't mask a genuine
    // connection failure at any other point in the flow.
    let hallCoreExpectedDown = false;
    const consoleIssues: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // Next.js dev-mode HMR/WebSocket reconnect noise is expected here —
      // this spec deliberately stops the backend mid-test, which is not
      // itself a page bug.
      if (/webpack-hmr|Fast Refresh/i.test(text)) return;
      if (hallCoreExpectedDown && text.includes("ERR_CONNECTION_REFUSED")) return;
      consoleIssues.push(text);
    });
    page.on("pageerror", (error) => {
      consoleIssues.push(`pageerror: ${error.message}`);
    });

    try {
      // --- Steps 1–3: start Hall Core A (durable), start Hall Web, open /system ---
      hallCore = spawnDurableHallCore({ workspaceRoot, dataDir, comparisonRoot });
      await waitForHallCoreHealth(hallCore.port);
      hallWeb = spawnDurableHallWeb(hallCore.port);
      await waitForHallWebReady(DURABLE_RESTART_WEB_PORT);

      await page.goto(`${baseUrl}/system`);

      // --- Steps 4–5: confirm durable mode and first-start status ---
      await expect(page.getByText("Durable")).toBeVisible();
      await expect(page.getByText("First startup")).toBeVisible();

      // --- Step 6+8 (combined — see doc comment above): create a deferred
      // task, set requirements via the "Simulation / testing" profile, and
      // route-and-assign Mock Agent, all without starting it.
      await page.goto(`${baseUrl}/board`);
      const title = `Durable restart e2e ${Date.now().toString()}`;
      await page.getByRole("button", { name: "+ New backlog task" }).click();
      await page.getByLabel("Project").fill("durable-restart-e2e");
      await page.getByLabel("Title").fill(title);
      await page.getByLabel("Working directory (optional, relative)").fill(sourceRepoRelativeDir);
      await page.getByRole("button", { name: "Add to Backlog" }).click();
      const card = page.locator("li", { has: page.getByText(title, { exact: true }) });
      await expect(card).toBeVisible();

      async function openActionsMenuFor(target: ReturnType<typeof page.locator>): Promise<void> {
        const trigger = target.getByRole("button", { name: "Actions" });
        await trigger.evaluate((element) => {
          element.scrollIntoView({ block: "center" });
        });
        await trigger.click();
      }

      await openActionsMenuFor(card);
      await page.getByRole("button", { name: "Move to Ready" }).click();
      await expect(card.getByText("Ready", { exact: true })).toBeVisible();

      await openActionsMenuFor(card);
      await page.getByRole("button", { name: "Find suitable agent" }).click();
      const routingDialog = page.getByRole("dialog", { name: /Find suitable agent/ });
      await expect(routingDialog).toBeVisible();
      await routingDialog
        .getByLabel("Requirement profile")
        .selectOption({ label: "Simulation / testing" });
      await expect(routingDialog.getByText(/Recommended "Mock Agent"/)).toBeVisible();
      await routingDialog.getByRole("button", { name: "Route and assign" }).click();
      await expect(card.getByText("Assigned", { exact: true })).toBeVisible();
      // The card renders the adapterId, not the adapter's display name.
      await expect(card.getByText("mock-agent", { exact: true })).toBeVisible();
      // Step 8's own explicit confirmation: assigning never starts a run.
      await expect(card).toContainText("0 events");

      // --- Step 9: one General Board message, one task-board message ---
      await page.goto(`${baseUrl}/boards`);
      const generalMessageText = `General board message ${Date.now().toString()}`;
      await page.getByLabel("Write a message").fill(generalMessageText);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText(generalMessageText)).toBeVisible();

      await page.goto(`${baseUrl}/board`);
      await openActionsMenuFor(card);
      await page.getByRole("button", { name: "Open discussion" }).click();
      await expect(page).toHaveURL(/\/boards\?boardId=.+/);
      const taskMessageText = `Task board message ${Date.now().toString()}`;
      await page.getByLabel("Write a message").fill(taskMessageText);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText(taskMessageText)).toBeVisible();

      // --- Steps 10–11: create a comparison, prepare both candidates ---
      // A *second*, separate Ready task — "Compare agents" is only ever
      // offered on a Ready card (never an Assigned one, which the first
      // task above already became).
      await page.goto(`${baseUrl}/board`);
      const comparisonTitle = `Durable restart e2e comparison ${Date.now().toString()}`;
      await page.getByRole("button", { name: "+ New backlog task" }).click();
      await page.getByLabel("Project").fill("durable-restart-e2e");
      await page.getByLabel("Title").fill(comparisonTitle);
      await page.getByLabel("Working directory (optional, relative)").fill(sourceRepoRelativeDir);
      await page.getByRole("button", { name: "Add to Backlog" }).click();
      const comparisonCard = page.locator("li", {
        has: page.getByText(comparisonTitle, { exact: true }),
      });
      await expect(comparisonCard).toBeVisible();
      await openActionsMenuFor(comparisonCard);
      await page.getByRole("button", { name: "Move to Ready" }).click();
      await expect(comparisonCard.getByText("Ready", { exact: true })).toBeVisible();

      await openActionsMenuFor(comparisonCard);
      await page.getByRole("button", { name: "Compare agents" }).click();
      const compareDialog = page.getByRole("dialog", { name: "Compare agents" });
      await expect(compareDialog).toBeVisible();
      // Codex's option is disabled in both slots (confirmed empirically —
      // see the file-level doc comment): Claude Code and Mock Agent are
      // the only two selectable adapters at all, so the dialog's own
      // default selection (one of each) is the only valid combination —
      // nothing to explicitly choose between.
      await expect(compareDialog.getByLabel("First candidate")).toHaveValue(/./);
      await expect(compareDialog.getByLabel("Second candidate")).toHaveValue(/./);
      await compareDialog.getByRole("button", { name: "Compare" }).click();
      await expect(page).toHaveURL(/\/comparisons\/.+/);
      const comparisonUrl = page.url();

      await page.getByRole("button", { name: "Prepare" }).click();
      await expect(page.getByText("Ready", { exact: true })).toBeVisible({ timeout: 20_000 });

      const candidatesSection = page.getByRole("region", { name: "Candidates" });
      const candidateAPanel = candidatesSection.locator("> div", { hasText: "Mock Agent" });
      const candidateBPanel = candidatesSection.locator("> div", { hasText: "Claude Code" });

      // --- Step 12: run candidate A (Mock Agent) to completion ---
      await candidateAPanel.getByRole("button", { name: "Start" }).click();
      await expect(candidateAPanel.getByText("Completed", { exact: true })).toBeVisible({
        timeout: 20_000,
      });

      // Candidate B (Claude Code) is deliberately left `Prepared` and
      // never started — see the file-level doc comment for why.
      await expect(candidateBPanel.getByText("Prepared", { exact: true })).toBeVisible();

      // --- Step 13: record a non-binding preference ---
      await page.getByLabel(/Mock Agent/).check();
      const preferenceNote = "Candidate A completed; recorded before restart.";
      await page.getByLabel("Note (optional)").fill(preferenceNote);
      await page.getByRole("button", { name: "Save preference" }).click();
      await expect(page.getByText(/informational only/i).first()).toBeVisible();

      // --- Step 14: visible identifiers to verify after restart ---
      // The task title, the two message texts, the comparison's own URL,
      // and the preference note (all set above) are this spec's stand-in
      // for "identifiers" — Hall Web never displays a raw taskId/boardId/
      // comparisonId as visible text, by design (see the no-leaked-path
      // assertions throughout this spec), so those human-visible strings
      // are what's actually re-checked after the restart below.

      // --- Steps 15–16: stop Hall Core A gracefully; Hall Web/browser stay open ---
      hallCoreExpectedDown = true;
      await hallCore.gracefulStop();
      // ServerStatus polls infrequently (every 30s) but re-checks
      // immediately on mount — reload (a client-side Next.js navigation,
      // served by Hall Web alone, which is unaffected) to force an
      // immediate, fast health check rather than waiting out the interval.
      await page.reload();
      await expect(page.getByText("Hall Core: Offline")).toBeVisible({ timeout: 10_000 });

      // --- Step 17: start Hall Core B with the same dataDir/workspaceRoot/comparisonRoot ---
      hallCore = spawnDurableHallCore({ workspaceRoot, dataDir, comparisonRoot });
      await waitForHallCoreHealth(hallCore.port);
      hallCoreExpectedDown = false;

      // --- Step 18: confirm Hall Web reconnects ---
      await page.reload();
      await expect(page.getByText("Hall Core: Online")).toBeVisible({ timeout: 10_000 });

      // --- Steps 19–21: task status/assignment/requirements survive; boards intact ---
      await page.goto(`${baseUrl}/board`);
      const cardAfterRestart = page.locator("li", { has: page.getByText(title, { exact: true }) });
      await expect(cardAfterRestart.getByText("Assigned", { exact: true })).toBeVisible();
      await expect(cardAfterRestart.getByText("mock-agent", { exact: true })).toBeVisible();

      await page.goto(`${baseUrl}/boards`);
      await expect(page.getByText(generalMessageText)).toBeVisible();
      const generalMessages = await page.getByText(generalMessageText).count();
      expect(generalMessages).toBe(1);

      await page.goto(`${baseUrl}/board`);
      await openActionsMenuFor(cardAfterRestart);
      await page.getByRole("button", { name: "Open discussion" }).click();
      await expect(page.getByText(taskMessageText)).toBeVisible();
      const taskMessages = await page.getByText(taskMessageText).count();
      expect(taskMessages).toBe(1);

      // --- Steps 22–23: comparison, candidate A result, and preference survive ---
      await page.goto(comparisonUrl);
      // The preference note is seeded into a <textarea> value from the
      // server's own persisted record — not standalone visible text — so
      // it must be asserted via its form value, not `getByText`.
      await expect(page.getByLabel("Note (optional)")).toHaveValue(preferenceNote);
      const candidateAPanelAfter = page
        .getByRole("region", { name: "Candidates" })
        .locator("> div", { hasText: "Mock Agent" });
      await expect(candidateAPanelAfter.getByText("Completed", { exact: true })).toBeVisible();

      // --- Steps 24–26 (adapted — see file-level doc comment): candidate
      // B remains exactly `Prepared`, untouched by the restart — still
      // never started, still not resumed or auto-run — while candidate
      // A's own completed result is unaffected by candidate B's state.
      const candidateBPanelAfter = page
        .getByRole("region", { name: "Candidates" })
        .locator("> div", { hasText: "Claude Code" });
      await expect(candidateBPanelAfter.getByText("Prepared", { exact: true })).toBeVisible();
      await expect(candidateAPanelAfter.getByText("Completed", { exact: true })).toBeVisible();

      // "Clean up" is only offered once every candidate is terminal — a
      // comparison with one candidate still `Prepared` stays `Running`
      // forever. Cancelling a not-yet-started candidate is itself a safe,
      // no-execution action (never touches the adapter — see
      // `0012-controlled-agent-comparison.md`, "REST API"), so it's used
      // here to reach a cleanup-eligible terminal state without ever
      // starting Claude Code.
      await candidateBPanelAfter.getByRole("button", { name: "Cancel" }).click();
      await expect(candidateBPanelAfter.getByText("Cancelled", { exact: true })).toBeVisible({
        timeout: 10_000,
      });

      // --- Steps 27–28: clean up, confirm it persists ---
      await page.getByRole("button", { name: "Clean up" }).click();
      await expect(page.getByText("Cleaned up", { exact: true }).first()).toBeVisible({
        timeout: 20_000,
      });
      await page.reload();
      await expect(page.getByText("Cleaned up", { exact: true }).first()).toBeVisible();

      // --- Steps 29–31: /system reports clean shutdown and correct status ---
      await page.goto(`${baseUrl}/system`);
      await expect(page.getByText("Durable")).toBeVisible();
      await expect(page.getByText("Clean", { exact: true })).toBeVisible();

      // --- Step 32: no dataDir/database/repository/worktree path visible ---
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toContain(tempRoot);
      expect(bodyText).not.toContain("hall-core.db");
      expect(bodyText).not.toContain("hall-core.lock");

      // --- Step 33: mobile viewport, no horizontal overflow ---
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${baseUrl}/system`);
      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(hasHorizontalOverflow).toBe(false);
      await page.setViewportSize({ width: 1280, height: 1400 });

      // --- Step 34: no console errors, hydration warnings, or CORS failures ---
      expect(consoleIssues).toEqual([]);
    } finally {
      // --- Steps 35–37: stop all processes, confirm cleanup ---
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
