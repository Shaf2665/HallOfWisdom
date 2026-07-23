import { defineConfig, devices } from "@playwright/test";

/**
 * Phase 11.1 — genuine, headless browser E2E verification without relying
 * on the Chrome extension. `webServer` starts a deterministic,
 * fixture-adapter Hall Core (`src/fixture-server.ts` — never a real
 * Claude Code/Codex process) and the real Hall Web dev server pointed at
 * it, both bound to `127.0.0.1` on the project's normal default ports
 * (4310/3000), matching every other manual-verification pass in this
 * repository. Playwright starts both, waits for them to be reachable,
 * runs the suite, then tears them down — `reuseExistingServer` is
 * disabled outside local development so a stale server can never mask a
 * real failure in CI-shaped runs.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // A taller-than-default viewport: tests run sequentially against
      // one long-lived fixture Hall Core process, so Kanban columns
      // accumulate cards across the whole run (there is no per-test
      // reset) — a short viewport pushes later tasks' cards, and the
      // `MoveMenu` popover portal-positioned beneath their "Actions"
      // trigger, past the bottom edge.
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 1400 } },
    },
  ],
  webServer: [
    {
      command: "node dist/fixture-server.js",
      cwd: import.meta.dirname,
      env: {
        HALL_CORE_E2E_PORT: "4310",
        HALL_CORE_E2E_WEB_ORIGIN: "http://127.0.0.1:3000",
      },
      url: "http://127.0.0.1:4310/api/v1/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @hall-of-wisdom/web run dev",
      cwd: "../..",
      url: "http://127.0.0.1:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
