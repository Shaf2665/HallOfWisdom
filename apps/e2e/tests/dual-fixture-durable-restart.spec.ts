import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { expect, test, type Locator } from "@playwright/test";
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
  DUAL_FIXTURE_DURABLE_RESTART_HALL_CORE_PORT,
  DUAL_FIXTURE_DURABLE_RESTART_WEB_PORT,
} from "../src/durable-restart-constants.js";
import { E2E_SOURCE_REPO_RELATIVE_DIR } from "../src/fixture-constants.js";

/**
 * Phase 13.2, kickoff §7–§8 — the full durable comparison restart flow,
 * genuinely started and genuinely completed on *both* sides of a real
 * durable restart, through the actual browser UI. Complements (does not
 * replace) `durable-restart.spec.ts` (Phase 13.1), which proves the real
 * production binary's own restart durability but — a genuine product
 * constraint documented there — has no way to register a second adapter
 * whose `startTask()` deterministically completes, so its own candidate B
 * is only ever prepared, never started.
 *
 * This spec closes that gap with test infrastructure, not a production
 * backdoor: `apps/e2e/src/fixture-server.ts`'s two comparison fixture
 * adapters (`hall.e2e-comparison-a`/`-b` — see `fixture-adapters.ts`,
 * already used by the non-durable `agent-comparison.spec.ts`) are
 * genuinely completing and deterministic, no network or provider usage.
 * The fixture composition reuses the real `ComparisonOrchestrator`, the
 * real Git worktree manager, the real SQLite durable stores, the real
 * REST/WebSocket routes, and — critically for this phase — the exact same
 * `openDurableStorage`/fencing sequence `server.ts` itself uses (see
 * `fixture-server.ts`'s and `durable-startup.ts`'s doc comments): this
 * spec exercises the real fence, not a parallel copy of it.
 *
 * The one hard requirement this spec exists to prove: after the restart,
 * candidate B's "Start" control is genuinely *clicked* — never a direct
 * REST call standing in for it — and candidate B actually completes.
 */

const CANDIDATE_A_LABEL = "E2E Comparison Adapter A";
const CANDIDATE_B_LABEL = "E2E Comparison Adapter B";

function eventCountLocator(panel: Locator): Locator {
  return panel.locator("dt", { hasText: "Events" }).locator("xpath=following-sibling::dd[1]");
}

async function openActionsMenuFor(target: Locator): Promise<void> {
  const trigger = target.getByRole("button", { name: "Actions" });
  await trigger.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
  });
  await trigger.click();
}

/**
 * The "Show diff" disclosure (`<details>`/`<summary>`) is uncontrolled —
 * its open/closed state lives on the DOM node itself, not in React state —
 * so it is safe to call this more than once across a spec: it only clicks
 * when the diff is not already visible, never toggling an already-open
 * panel closed.
 */
async function ensureDiffOpen(panel: Locator): Promise<void> {
  const boundedDiff = panel.locator("pre");
  if (!(await boundedDiff.isVisible())) {
    await panel.getByText("Show diff", { exact: true }).click();
  }
  await expect(boundedDiff).toBeVisible();
}

function changedFilesLocator(panel: Locator): Locator {
  return panel.locator("ul li");
}

function boundedDiffLocator(panel: Locator): Locator {
  return panel.locator("pre");
}

const FORBIDDEN_EVIDENCE_SUBSTRINGS = [
  "owner_token",
  "ownerToken",
  "epoch",
  "heartbeat",
  "stderr",
  "Authorization",
  "hall-core.db",
  "hall-core.lock",
] as const;

function assertNoLeakedDiagnostics(text: string, tempRoot: string): void {
  for (const forbidden of FORBIDDEN_EVIDENCE_SUBSTRINGS) {
    expect(text).not.toContain(forbidden);
  }
  expect(text).not.toContain(tempRoot);
  // No absolute filesystem path of either common platform shape.
  expect(text).not.toMatch(/[A-Za-z]:\\/);
  expect(text).not.toMatch(/\/(?:home|Users)\//);
}

test.describe("Dual-fixture durable comparison restart (Phase 13.2)", () => {
  test("candidate A starts before the restart, candidate B is genuinely clicked and started after it, and neither candidate's events cross into the other", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    requireDualFixtureDurableRestartBuildArtifacts();

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hall-dual-fixture-restart-e2e-"));
    const workspaceRoot = path.join(tempRoot, "workspace");
    const dataDir = path.join(tempRoot, "data");
    const comparisonRoot = path.join(tempRoot, "comparisons");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(comparisonRoot, { recursive: true });

    const baseUrl = `http://127.0.0.1:${String(DUAL_FIXTURE_DURABLE_RESTART_WEB_PORT)}`;
    let hallCore: SpawnedHallCore | undefined;
    let hallWeb: ChildProcess | undefined;

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
      // --- Steps 1–3: start fixture Hall Core A (durable), Hall Web, /system ---
      hallCore = spawnDurableFixtureHallCore({
        workspaceRoot,
        dataDir,
        comparisonRoot,
        port: DUAL_FIXTURE_DURABLE_RESTART_HALL_CORE_PORT,
        webPort: DUAL_FIXTURE_DURABLE_RESTART_WEB_PORT,
      });
      await waitForHallCoreHealth(hallCore.port);
      hallWeb = spawnDurableHallWeb(hallCore.port, DUAL_FIXTURE_DURABLE_RESTART_WEB_PORT);
      await waitForHallWebReady(DUAL_FIXTURE_DURABLE_RESTART_WEB_PORT);

      // This fixture composition deliberately does not call the full
      // `runRestartRecovery` (see `fixture-server.ts`'s doc comment) —
      // `previousShutdown`/recovery-summary fidelity is already thoroughly
      // covered by `durable-restart.spec.ts` against the real production
      // binary, so only `mode` (set directly, independent of recovery) is
      // asserted here.
      await page.goto(`${baseUrl}/system`);
      await expect(page.getByText("Durable")).toBeVisible();

      // --- Step 3+4 combined: a Ready source task, then a comparison against both fixture adapters ---
      await page.goto(`${baseUrl}/board`);
      const title = `Dual-fixture restart e2e ${Date.now().toString()}`;
      await page.getByRole("button", { name: "+ New backlog task" }).click();
      await page.getByLabel("Project").fill("dual-fixture-restart-e2e");
      await page.getByLabel("Title").fill(title);
      await page
        .getByLabel("Working directory (optional, relative)")
        .fill(E2E_SOURCE_REPO_RELATIVE_DIR);
      await page.getByRole("button", { name: "Add to Backlog" }).click();
      const card = page.locator("li", { has: page.getByText(title, { exact: true }) });
      await expect(card).toBeVisible();

      await openActionsMenuFor(card);
      await page.getByRole("button", { name: "Move to Ready" }).click();
      await expect(card.getByText("Ready", { exact: true })).toBeVisible();

      await openActionsMenuFor(card);
      await page.getByRole("button", { name: "Compare agents" }).click();
      const compareDialog = page.getByRole("dialog", { name: "Compare agents" });
      await expect(compareDialog).toBeVisible();
      await compareDialog.getByLabel("First candidate").selectOption({ label: CANDIDATE_A_LABEL });
      await compareDialog.getByLabel("Second candidate").selectOption({ label: CANDIDATE_B_LABEL });
      await compareDialog.getByRole("button", { name: "Compare" }).click();
      await expect(page).toHaveURL(/\/comparisons\/.+/);
      const comparisonUrl = page.url();

      // --- Step 5: prepare both worktrees ---
      await page.getByRole("button", { name: "Prepare" }).click();
      await expect(page.getByText("Ready", { exact: true })).toBeVisible({ timeout: 20_000 });

      const candidatesSection = page.getByRole("region", { name: "Candidates" });
      const candidateAPanel = candidatesSection.locator("> div", { hasText: CANDIDATE_A_LABEL });
      const candidateBPanel = candidatesSection.locator("> div", { hasText: CANDIDATE_B_LABEL });

      // --- Steps 6–7: start candidate A, confirm it completes ---
      await candidateAPanel.getByRole("button", { name: "Start" }).click();
      await expect(candidateAPanel.getByText("Completed", { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(eventCountLocator(candidateAPanel)).toHaveText("2");

      // --- Step 8: candidate B remains prepared with zero events ---
      await expect(candidateBPanel.getByText("Prepared", { exact: true })).toBeVisible();
      await expect(eventCountLocator(candidateBPanel)).toHaveText("0");

      // --- Step 9: record a non-binding preference ---
      await page.getByLabel(new RegExp(CANDIDATE_A_LABEL)).check();
      const preferenceNote = "Candidate A completed before restart.";
      await page.getByLabel("Note (optional)").fill(preferenceNote);
      await page.getByRole("button", { name: "Save preference" }).click();
      await expect(page.getByText(/informational only/i).first()).toBeVisible();

      // --- Steps 10–11: stop Core A gracefully; Hall Web/browser stay open; confirm offline ---
      hallCoreExpectedDown = true;
      await hallCore.gracefulStop();
      await page.reload();
      await expect(page.getByText("Hall Core: Offline")).toBeVisible({ timeout: 10_000 });

      // --- Step 12: start fixture Hall Core B, same dataDir/workspaceRoot/comparisonRoot ---
      hallCore = spawnDurableFixtureHallCore({
        workspaceRoot,
        dataDir,
        comparisonRoot,
        port: DUAL_FIXTURE_DURABLE_RESTART_HALL_CORE_PORT,
        webPort: DUAL_FIXTURE_DURABLE_RESTART_WEB_PORT,
      });
      await waitForHallCoreHealth(hallCore.port);
      hallCoreExpectedDown = false;

      // --- Step 13: confirm Hall Web reconnects ---
      await page.reload();
      await expect(page.getByText("Hall Core: Online")).toBeVisible({ timeout: 10_000 });

      // --- Steps 14–15: candidate A's result/events and candidate B's prepared state both survive ---
      await page.goto(comparisonUrl);
      await expect(page.getByLabel("Note (optional)")).toHaveValue(preferenceNote);
      const candidateAPanelAfter = page
        .getByRole("region", { name: "Candidates" })
        .locator("> div", { hasText: CANDIDATE_A_LABEL });
      const candidateBPanelAfter = page
        .getByRole("region", { name: "Candidates" })
        .locator("> div", { hasText: CANDIDATE_B_LABEL });
      await expect(candidateAPanelAfter.getByText("Completed", { exact: true })).toBeVisible();
      await expect(eventCountLocator(candidateAPanelAfter)).toHaveText("2");
      await expect(candidateBPanelAfter.getByText("Prepared", { exact: true })).toBeVisible();
      await expect(eventCountLocator(candidateBPanelAfter)).toHaveText("0");

      // --- Diff evidence baseline (kickoff §2, item 8's prerequisite): capture
      // candidate A's diff/evidence region right after restart, before candidate
      // B ever runs, so the later post-B comparison genuinely proves A's
      // evidence was untouched by B's run rather than merely never re-checked ---
      await ensureDiffOpen(candidateAPanelAfter);
      const candidateAChangedFilesBefore =
        await changedFilesLocator(candidateAPanelAfter).allInnerTexts();
      const candidateADiffBefore = await boundedDiffLocator(candidateAPanelAfter).innerText();
      expect(candidateAChangedFilesBefore.join("\n")).toContain("candidate-a-output.txt");
      expect(candidateADiffBefore).toContain("output from candidate A");

      // --- Steps 16–18: genuinely click Start on candidate B — the core proof this
      // spec exists for — confirm it completes, with its own correct event count ---
      await candidateBPanelAfter.getByRole("button", { name: "Start" }).click();
      await expect(candidateBPanelAfter.getByText("Completed", { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(eventCountLocator(candidateBPanelAfter)).toHaveText("2");

      // --- Diff evidence verification (kickoff §2), after candidate B has
      // completed following the durable restart ---

      // Item 1: open candidate A's diff/evidence region (already open from the
      // baseline capture above — `ensureDiffOpen` never closes an open panel).
      await ensureDiffOpen(candidateAPanelAfter);
      // Item 2: candidate A's expected controlled relative file path is displayed.
      const candidateAChangedFilesAfter =
        await changedFilesLocator(candidateAPanelAfter).allInnerTexts();
      expect(candidateAChangedFilesAfter.join("\n")).toContain("candidate-a-output.txt");
      expect(candidateAChangedFilesAfter.join("\n")).not.toContain("candidate-b-output.txt");
      // Item 3: candidate A's controlled edit is represented in its bounded diff.
      const candidateADiffAfter = await boundedDiffLocator(candidateAPanelAfter).innerText();
      expect(candidateADiffAfter).toContain("output from candidate A");
      expect(candidateADiffAfter).not.toContain("output from candidate B");

      // Item 4: open candidate B's diff/evidence region.
      await ensureDiffOpen(candidateBPanelAfter);
      // Item 5: candidate B's expected controlled relative file path is displayed.
      const candidateBChangedFiles =
        await changedFilesLocator(candidateBPanelAfter).allInnerTexts();
      expect(candidateBChangedFiles.join("\n")).toContain("candidate-b-output.txt");
      expect(candidateBChangedFiles.join("\n")).not.toContain("candidate-a-output.txt");
      // Item 6: candidate B's own, distinct controlled edit is represented.
      const candidateBDiff = await boundedDiffLocator(candidateBPanelAfter).innerText();
      expect(candidateBDiff).toContain("output from candidate B");
      expect(candidateBDiff).not.toContain("output from candidate A");

      // Item 7: the two candidates remain separately labelled — each panel
      // still shows only its own adapter's display name and evidence, never
      // the other's.
      await expect(candidateAPanelAfter.getByText(CANDIDATE_A_LABEL)).toBeVisible();
      await expect(candidateBPanelAfter.getByText(CANDIDATE_B_LABEL)).toBeVisible();

      // Item 8: candidate A's evidence did not change when B ran — byte-for-byte
      // identical to the baseline captured before B was ever started.
      expect(candidateAChangedFilesAfter).toEqual(candidateAChangedFilesBefore);
      expect(candidateADiffAfter).toBe(candidateADiffBefore);

      // Items 9–10: no absolute path, raw stderr, auth data, owner token, or
      // epoch anywhere in either candidate's evidence region.
      assertNoLeakedDiagnostics(candidateADiffAfter, tempRoot);
      assertNoLeakedDiagnostics(candidateAChangedFilesAfter.join("\n"), tempRoot);
      assertNoLeakedDiagnostics(candidateBDiff, tempRoot);
      assertNoLeakedDiagnostics(candidateBChangedFiles.join("\n"), tempRoot);

      // Item 11: the diff is bounded (well under any pathological size — this
      // fixture writes a single one-line file, so a healthy bound is a few
      // hundred characters, not thousands) and reachable through a stable,
      // accessible locator (`<pre>` inside the already-verified panel region) —
      // deliberately not asserting the diff's exact raw text/whitespace.
      expect(candidateADiffAfter.length).toBeLessThan(2000);
      expect(candidateBDiff.length).toBeLessThan(2000);

      // Item 12: neither candidate's Start control is touched again beyond the
      // single earlier click each received — no further start/click calls
      // appear anywhere below this point in the spec.

      // --- Steps 19–20: candidate A's history is unchanged; events never crossed
      // between candidates — each panel's own count is exactly its own real
      // event count (2 and 2), never inflated by the other's run ---
      await expect(candidateAPanelAfter.getByText("Completed", { exact: true })).toBeVisible();
      await expect(eventCountLocator(candidateAPanelAfter)).toHaveText("2");

      // --- Step 22: the recorded preference remains non-binding/untouched ---
      await expect(page.getByLabel("Note (optional)")).toHaveValue(preferenceNote);

      // --- Step 23: clean up (both candidates are now terminal) ---
      await page.getByRole("button", { name: "Clean up" }).click();
      await expect(page.getByText("Cleaned up", { exact: true }).first()).toBeVisible({
        timeout: 20_000,
      });

      // --- Step 24: confirm cleanup persisted, via reload (querying durable state) ---
      await page.reload();
      await expect(page.getByText("Cleaned up", { exact: true }).first()).toBeVisible();

      // --- Step 26: no absolute path or database metadata visible anywhere ---
      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toContain(tempRoot);
      expect(bodyText).not.toContain("hall-core.db");
      expect(bodyText).not.toContain("hall-core.lock");

      expect(consoleIssues).toEqual([]);
    } finally {
      // --- Step 27: stop all processes, confirm cleanup ---
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
