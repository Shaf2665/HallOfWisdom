import { expect, test } from "@playwright/test";

/**
 * Phase 11.1 E2E — the Agents catalog page, against the deterministic
 * fixture Hall Core (`src/fixture-server.ts`): Mock is `simulated`,
 * Claude Code is `isolated`, Codex is `trusted_local`, matching the
 * required state from the kickoff. No provider process is ever started —
 * every adapter here is a fixture whose `startTask()` always rejects.
 */
test.describe("Agents catalog", () => {
  test("shows every fixture adapter with its exact execution trust, the trusted-local warning, and no sensitive data", async ({
    page,
  }) => {
    await page.goto("/agents");

    const table = page.getByRole("table");
    await expect(table).toBeVisible();

    // 2-4: exact trust values, never softened.
    const mockRow = table.getByRole("row", { name: /Mock Agent/ });
    await expect(mockRow).toContainText("simulated");
    const claudeRow = table.getByRole("row", { name: /Claude Code/ });
    await expect(claudeRow).toContainText("isolated");
    const codexRow = table.getByRole("row", { name: /Codex/ });
    await expect(codexRow).toContainText("trusted_local");

    // 5. Trusted-local Codex warning is visible (desktop limitations
    // panel) — the same text also appears inside the mobile card list,
    // which stays present in the DOM (CSS-hidden, not unmounted) at any
    // viewport; at this default desktop-sized viewport, the *mobile*
    // list's copy is the CSS-hidden one, and it renders earlier in DOM
    // order than the desktop panel — so `.last()`, not `.first()`, is
    // the currently-visible match here.
    await expect(
      page.getByText(/Codex sandbox and approval protections are bypassed/).last(),
    ).toBeVisible();

    // 6-9. No sensitive data ever appears anywhere on the page. Deliberately
    // narrow patterns, not a bare `/auth/i` — this page's own legitimate
    // copy ("Authenticated does not mean isolated.") contains that
    // substring; the point is to catch actual credential-shaped leakage,
    // not to forbid the word.
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/executablePath/i);
    expect(bodyText).not.toMatch(/\.exe|\.cmd|\.bat/);
    expect(bodyText).not.toMatch(/CODEX_HOME/);
    expect(bodyText).not.toMatch(/api[_-]?key\s*[:=]/i);
    expect(bodyText).not.toMatch(/bearer\s+[a-z0-9._-]{10,}/i);
    expect(bodyText).not.toMatch(/OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN/);

    // 10. Desktop adapter comparison is usable — every fixture's row is
    // visible and legible in the desktop table.
    await expect(mockRow).toBeVisible();
    await expect(claudeRow).toBeVisible();
    await expect(codexRow).toBeVisible();
  });

  test("is usable at a 390x844 mobile viewport with no page-level horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/agents");

    // The desktop table stays in the DOM (CSS-hidden via `hidden md:block`)
    // even at a narrow viewport; the mobile card list (`md:hidden` on
    // its own `<ul>`) is the one actually visible here — scope to it
    // explicitly rather than the ambiguous, page-wide text match.
    const mobileList = page.getByRole("list").filter({ hasText: "Mock Agent" });
    await expect(mobileList).toBeVisible();
    // `exact: true` — each adapter's *name* span reads exactly this text;
    // Codex's own limitation text ("Trusted-local mode: Codex sandbox...")
    // also contains the substring "Codex" but is never an exact match.
    await expect(mobileList.getByText("Mock Agent", { exact: true })).toBeVisible();
    await expect(mobileList.getByText("Claude Code", { exact: true })).toBeVisible();
    await expect(mobileList.getByText("Codex", { exact: true })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});
