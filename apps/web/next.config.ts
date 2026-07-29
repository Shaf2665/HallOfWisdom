import type { NextConfig } from "next";

/**
 * `distDir` defaults to `.next`. Next.js's own dev server refuses to run
 * two concurrent instances against the same project directory regardless
 * of port — they'd share one `.next/` build cache and PID lock. Phase
 * 13.1's `apps/e2e/tests/durable-restart.spec.ts` needs a second,
 * independent Hall Web dev server (pointed at its own dedicated Hall
 * Core instance) running alongside the shared suite's own `next dev` on
 * port 3000 — so it sets `HALL_E2E_DURABLE_DIST_DIR` to give its instance
 * a separate build output directory, sidestepping the conflict. Inert
 * for every other invocation (including production builds and the
 * shared e2e suite), which never set this variable.
 *
 * `typescript.tsconfigPath` is set alongside it for the same reason:
 * Next.js's dev server auto-writes `include` entries into whichever
 * tsconfig it's pointed at (to reference the new `distDir`'s generated
 * type-checking files) — pointing this instance at its own throwaway
 * `tsconfig.durable-restart-e2e.json` (written by the harness before
 * each spawn, `extends` the real one, gitignored) keeps that write
 * confined there instead of mutating the tracked `tsconfig.json`.
 */
const nextConfig: NextConfig = {
  ...(process.env.HALL_E2E_DURABLE_DIST_DIR !== undefined
    ? {
        distDir: process.env.HALL_E2E_DURABLE_DIST_DIR,
        typescript: { tsconfigPath: "tsconfig.durable-restart-e2e.json" },
      }
    : {}),
};

export default nextConfig;
