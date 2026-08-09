import { expect, test } from "@playwright/test";

/**
 * Phase 17.2 E2E — the Providers page, against the same deterministic
 * fixture Hall Core `apps/e2e/tests/agents-catalog.spec.ts` already uses:
 * Claude Code and Codex are both `available` fixtures with real
 * `diagnosticMessage` values (Codex is `trusted_local`). No provider
 * process is ever started — every adapter here is a fixture whose
 * `startTask()` always rejects, and this spec never spawns `claude`/`codex`
 * itself either (Connect is a static client-only guidance panel).
 */
test.describe("Providers page", () => {
  test("shows Claude Code and Codex as Connected, never Mock Agent, with no sensitive data", async ({
    page,
  }) => {
    await page.goto("/providers");

    const list = page.getByRole("list");
    await expect(list).toBeVisible();
    await expect(list.getByText("Claude Code", { exact: true })).toBeVisible();
    await expect(list.getByText("Codex", { exact: true })).toBeVisible();
    await expect(list.getByText("Mock Agent", { exact: true })).toHaveCount(0);

    const claudeCard = list.getByRole("listitem").filter({ hasText: "Claude Code" });
    await expect(claudeCard.getByText("Connected")).toBeVisible();
    const codexCard = list.getByRole("listitem").filter({ hasText: "Codex" });
    await expect(codexCard.getByText("Connected")).toBeVisible();
    await expect(codexCard.getByText(/not OS-sandboxed/)).toBeVisible();

    // Expand technical details so the leak scan below actually covers the
    // one panel most likely to ever carry a path or version string.
    await claudeCard.getByRole("button", { name: "Show technical details" }).click();
    await codexCard.getByRole("button", { name: "Show technical details" }).click();

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/executablePath/i);
    // Word-boundary after the extension: catches a real leaked path like
    // "claude.exe" without false-matching capability names such as
    // "command.execute" (declared-capabilities text now in scope below).
    expect(bodyText).not.toMatch(/\.exe\b|\.cmd\b|\.bat\b/);
    expect(bodyText).not.toMatch(/CODEX_HOME/);
    expect(bodyText).not.toMatch(/api[_-]?key\s*[:=]/i);
    expect(bodyText).not.toMatch(/bearer\s+[a-z0-9._-]{10,}/i);
    expect(bodyText).not.toMatch(/OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN/);
  });

  test("Connect shows the provider's own official login command and never touches the server", async ({
    page,
  }) => {
    await page.goto("/providers");
    const claudeCard = page.getByRole("listitem").filter({ hasText: "Claude Code" });

    // Attach the listener only once the initial listAdapters() page-load
    // request has already settled, so it can't false-flag on normal load.
    await expect(claudeCard.getByRole("button", { name: "Connect" })).toBeVisible();
    const apiRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/adapters")) apiRequests.push(request.url());
    });

    await claudeCard.getByRole("button", { name: "Connect" }).click();
    await expect(claudeCard.getByText("claude auth login")).toBeVisible();
    expect(apiRequests).toEqual([]);
  });

  test("Recheck re-fetches this provider's status without reloading the page", async ({
    page,
  }) => {
    await page.goto("/providers");
    const claudeCard = page.getByRole("listitem").filter({ hasText: "Claude Code" });

    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/v1/adapters/hall.claude-code")),
      claudeCard.getByRole("button", { name: "Recheck" }).click(),
    ]);
    expect(response.status()).toBe(200);
    await expect(claudeCard.getByText("Connected")).toBeVisible();
    // Discriminates a real onUpdated() apply from handleRecheck()'s catch
    // branch, which would leave a role="alert" error message in the card.
    await expect(claudeCard.getByRole("alert")).toHaveCount(0);
  });

  test("is usable at a 390x844 mobile viewport with no page-level horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/providers");

    await expect(page.getByText("Claude Code", { exact: true })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});
