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

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/executablePath/i);
    expect(bodyText).not.toMatch(/\.exe|\.cmd|\.bat/);
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

    let connectRequestSeen = false;
    page.on("request", (request) => {
      if (request.url().includes("/connect")) connectRequestSeen = true;
    });

    await claudeCard.getByRole("button", { name: "Connect" }).click();
    await expect(claudeCard.getByText("claude login")).toBeVisible();
    expect(connectRequestSeen).toBe(false);
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
