import { expect, type Page, test } from "@playwright/test";
import { E2E_SOURCE_REPO_RELATIVE_DIR } from "../src/fixture-constants.js";

/**
 * Phase 12 E2E — the multi-agent comparison workflow, against the
 * deterministic fixture Hall Core (`src/fixture-server.ts`), which
 * enables the comparison feature with a real, temp-directory Git
 * repository as its workspace root and registers two fixture adapters
 * (`createFixtureComparisonAdapter` — "E2E Comparison Adapter A"/"B")
 * whose `startTask()` actually completes, unlike every other fixture in
 * this suite. Every other adapter registered in the fixture server
 * (Mock Agent, Claude Code, Codex fixtures) still always rejects
 * `startTask()` — this spec always explicitly selects the two named
 * completing adapters in the "Compare agents" dialog rather than
 * accepting its auto-selected default, specifically to avoid starting a
 * candidate against one of those.
 *
 * Phase 12.1 — the fixture server's `workspaceRoot` is itself a Git
 * repository left deliberately DIRTY (an uncommitted file), with a
 * separate, independent, CLEAN Git repository nested at
 * `E2E_SOURCE_REPO_RELATIVE_DIR` — reproducing the exact real-world
 * finding a genuine comparison run surfaced (`workspaceRoot` is a security
 * boundary, never itself the source repository). Every task created below
 * fills "Working directory" with that nested repo's relative path.
 *
 * Never a real Claude Code/Codex process, never any subscription usage.
 */

async function createBacklogTask(
  page: Page,
  title: string,
  options: { readonly workingDirectory?: string } = {},
): Promise<void> {
  await page.getByRole("button", { name: "+ New backlog task" }).click();
  await page.getByLabel("Project").fill("e2e-project");
  await page.getByLabel("Title").fill(title);
  if (options.workingDirectory !== undefined) {
    await page.getByLabel("Working directory (optional, relative)").fill(options.workingDirectory);
  }
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

async function moveToReady(page: Page, title: string): Promise<void> {
  const card = page.locator("li", { has: page.getByText(title, { exact: true }) });
  await openActionsMenu(card);
  await page.getByRole("button", { name: "Move to Ready" }).click();
  await expect(card.getByText("Ready")).toBeVisible();
}

function cardFor(page: Page, title: string) {
  return page.locator("li", { has: page.getByText(title, { exact: true }) });
}

test.describe("Multi-agent execution comparison", () => {
  test("create -> prepare -> start each candidate sequentially -> view diffs -> record a preference -> clean up", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `Comparison task ${Date.now().toString()}`;
    await createBacklogTask(page, title, { workingDirectory: E2E_SOURCE_REPO_RELATIVE_DIR });
    await moveToReady(page, title);

    const card = cardFor(page, title);
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Compare agents" }).click();

    const dialog = page.getByRole("dialog", { name: "Compare agents" });
    await expect(dialog).toBeVisible();

    // Explicitly select the two adapters whose fixture `startTask()`
    // actually completes — never accept whatever the dialog defaults to.
    await dialog.getByLabel("First candidate").selectOption({ label: "E2E Comparison Adapter A" });
    await dialog.getByLabel("Second candidate").selectOption({ label: "E2E Comparison Adapter B" });

    await dialog.getByRole("button", { name: "Compare" }).click();

    // Creating a comparison navigates away from the board to its detail page.
    await expect(page).toHaveURL(/\/comparisons\/.+/);
    await expect(page.getByText(title)).toBeVisible();
    await expect(page.getByText("Draft")).toBeVisible();

    // Phase 12.1 regression: `workspaceRoot` itself is a dirty Git
    // repository (`unrelated-dirty-file.txt`, never committed) — this
    // succeeding at all proves the comparison resolved and checked the
    // NESTED `source-repo` repository's own cleanliness, not
    // `workspaceRoot`'s. Before the fix, this would have failed with
    // `COMPARISON_SOURCE_REPOSITORY_DIRTY` against the outer workspace.
    await page.getByRole("button", { name: "Prepare" }).click();
    await expect(page.getByText("Ready", { exact: true })).toBeVisible({ timeout: 15_000 });

    // No absolute filesystem path (of either the workspace root or the
    // comparison root, both real OS temp directories) ever reaches the browser.
    const pageTextAfterPrepare = await page.locator("body").innerText();
    expect(pageTextAfterPrepare).not.toContain("hall-e2e-workspace-");
    expect(pageTextAfterPrepare).not.toContain("hall-e2e-comparison-root-");

    // Scoped to direct children of the "Candidates" region (each a
    // `CandidatePanel`) — not a generic `div` text match, which would
    // ambiguously match every ancestor div too.
    const candidatesSection = page.getByRole("region", { name: "Candidates" });
    const candidateAPanel = candidatesSection.locator("> div", {
      hasText: "E2E Comparison Adapter A",
    });
    const candidateBPanel = candidatesSection.locator("> div", {
      hasText: "E2E Comparison Adapter B",
    });

    // Sequential-only: start candidate A, wait for it to actually
    // complete before candidate B's own "Start" button is ever clicked —
    // this spec never attempts to start both at once (the backend would
    // reject a concurrent attempt with a 409, exercised at the unit/
    // integration level already, not re-proven here).
    await candidateAPanel.getByRole("button", { name: "Start" }).click();
    await expect(candidateAPanel.getByText("Completed", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // The collapsed diff's <details> content is still present in the DOM
    // (just visually hidden), and also contains this filename — scope to
    // the changed-files list item specifically, not the diff text.
    await expect(candidateAPanel.getByText("candidate-a-output.txt").first()).toBeVisible();

    await candidateBPanel.getByRole("button", { name: "Start" }).click();
    await expect(candidateBPanel.getByText("Completed", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(candidateBPanel.getByText("candidate-b-output.txt").first()).toBeVisible();

    // Isolation from the outer, dirty workspace: neither candidate's
    // changed-files list ever mentions the unrelated file left uncommitted
    // in `workspaceRoot` — each candidate's worktree was created from the
    // nested `source-repo` repository alone.
    await expect(candidateAPanel.getByText("unrelated-dirty-file.txt")).toHaveCount(0);
    await expect(candidateBPanel.getByText("unrelated-dirty-file.txt")).toHaveCount(0);

    // The comparison as a whole reaches "Completed" once both candidates
    // have — the page's own top-level status badge, not a candidate's.
    // Scoped to the ancestor <section> of the title <h2> so this never
    // ambiguously matches either candidate panel's own "Completed" badge.
    const topSection = page.locator("h2", { hasText: title }).locator("xpath=ancestor::section[1]");
    await expect(topSection.getByText("Completed", { exact: true })).toBeVisible();

    // The bounded diff viewer never uses dangerouslySetInnerHTML — a
    // <pre> containing the raw unified diff text, collapsed by default.
    await candidateAPanel.getByText("Show diff").click();
    await expect(candidateAPanel.locator("pre")).toContainText("candidate-a-output.txt");

    // Record a non-binding preference.
    await page.getByLabel(/E2E Comparison Adapter A \(hall\.e2e-comparison-a\)/).check();
    await page.getByLabel("Note (optional)").fill("Faster and cleaner.");
    await page.getByRole("button", { name: "Save preference" }).click();
    await expect(page.getByText(/informational only/i).first()).toBeVisible();

    // Clean up: tears down both worktrees; status moves to "Cleaned up".
    await page.getByRole("button", { name: "Clean up" }).click();
    await expect(page.getByText("Cleaned up", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // The comparison also appears, with its final status, from the list page.
    await page.goto("/comparisons");
    const listRow = page.locator("tr, li", { hasText: title }).first();
    await expect(listRow.getByText("Cleaned up")).toBeVisible();
  });

  test("never allows selecting the same adapter for both candidates, and Cancel discards the dialog without creating anything", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `Comparison cancel task ${Date.now().toString()}`;
    await createBacklogTask(page, title);
    await moveToReady(page, title);

    const card = cardFor(page, title);
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Compare agents" }).click();

    const dialog = page.getByRole("dialog", { name: "Compare agents" });
    await expect(dialog).toBeVisible();

    const firstSelect = dialog.getByLabel("First candidate");
    const secondSelect = dialog.getByLabel("Second candidate");
    await firstSelect.selectOption({ label: "E2E Comparison Adapter A" });

    const secondOptions = secondSelect.locator("option");
    const duplicateOption = secondOptions.filter({ hasText: "E2E Comparison Adapter A" });
    await expect(duplicateOption).toBeDisabled();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page).toHaveURL(/\/board/);
  });

  test("prepare fails safely, with a visible reason and no leaked path, when the source task has no working directory", async ({
    page,
  }) => {
    await page.goto("/board");
    const title = `Comparison no-working-dir task ${Date.now().toString()}`;
    // Deliberately never fills "Working directory" — Phase 12.1 requires
    // this to be rejected rather than silently falling back to
    // `workspaceRoot`.
    await createBacklogTask(page, title);
    await moveToReady(page, title);

    const card = cardFor(page, title);
    await openActionsMenu(card);
    await page.getByRole("button", { name: "Compare agents" }).click();

    const dialog = page.getByRole("dialog", { name: "Compare agents" });
    await dialog.getByLabel("First candidate").selectOption({ label: "E2E Comparison Adapter A" });
    await dialog.getByLabel("Second candidate").selectOption({ label: "E2E Comparison Adapter B" });
    await dialog.getByRole("button", { name: "Compare" }).click();

    await expect(page).toHaveURL(/\/comparisons\/.+/);
    await page.getByRole("button", { name: "Prepare" }).click();

    await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/Preparation failed:/)).toBeVisible();
    await expect(
      page.getByText(/has no working directory set; comparisons require one/),
    ).toBeVisible();

    // No absolute path leaked in the failure reason or anywhere else on the page.
    const pageText = await page.locator("body").innerText();
    expect(pageText).not.toContain("hall-e2e-workspace-");
    expect(pageText).not.toContain("hall-e2e-comparison-root-");

    // Both candidates remain pending — nothing was ever started, no worktree created.
    const candidatesSection = page.getByRole("region", { name: "Candidates" });
    await expect(candidatesSection.getByText("Pending", { exact: true })).toHaveCount(2);
  });
});
