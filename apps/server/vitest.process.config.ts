import { defineConfig } from "vitest/config";

/**
 * A dedicated Vitest config for `src/process-tests/**` only — real OS
 * child processes spawning the actual built `dist/server.js` binary,
 * never `runServer()` in-process. These tests are excluded from the
 * default `vitest.config.ts`'s `include` so a plain `pnpm test` never
 * depends on stale or missing build output.
 *
 * Run via `pnpm run test:process` (this package) or, preferably, the
 * root `pnpm verify:process-recovery` command, which builds first —
 * every test file in this directory throws a clear, actionable error
 * (via `requireBuiltDist()`) rather than silently skipping if `dist/`
 * is missing, so a stale checkout fails loudly instead of passing
 * green with untested coverage.
 *
 * Longer default timeout than the main config: these tests spawn real
 * processes and, in one case, wait out a real ownership-staleness
 * window — see `hard-crash-restart.test.ts`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/process-tests/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 60000,
    // Real OS processes bind real ports — run this file serially, not
    // interleaved with itself, to avoid two tests racing for the same
    // fixed port numbers.
    fileParallelism: false,
  },
});
