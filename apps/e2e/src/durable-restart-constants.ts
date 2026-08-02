/**
 * Side-effect-free constants for `tests/durable-restart.spec.ts` and its
 * harness module (`durable-restart-harness.ts`) — kept in their own
 * module, mirroring `fixture-constants.ts`'s own reasoning: nothing here
 * may ever have an import-time side effect, so importing it can never
 * accidentally start or interfere with a process.
 *
 * Deliberately distinct from the shared suite's ports (3000/4310, owned
 * by Playwright's own `webServer` config in `playwright.config.ts`) and
 * from `apps/server`'s own process-level test ports (the 47000s) — this
 * spec spawns and owns two entirely separate, real OS processes (the
 * actual built Hall Core binary and a dedicated Hall Web dev server) for
 * its own exclusive use, never touching the shared fixture pair.
 */
export const DURABLE_RESTART_HALL_CORE_PORT = 4395;
export const DURABLE_RESTART_WEB_PORT = 3095;

/**
 * Phase 13.2 — the dual-fixture-adapter durable comparison restart spec
 * (`dual-fixture-durable-restart.spec.ts`) spawns its own separate Hall
 * Core (the E2E fixture composition, not the production binary) and Hall
 * Web pair, on yet another pair of dedicated ports, for the same reason
 * `durable-restart.spec.ts` uses its own: it needs to stop and restart
 * Hall Core mid-test while Hall Web and the browser stay open.
 */
export const DUAL_FIXTURE_DURABLE_RESTART_HALL_CORE_PORT = 4396;
export const DUAL_FIXTURE_DURABLE_RESTART_WEB_PORT = 3096;

/**
 * Phase 14.1 — the CEO plan editing/delegation durable restart spec
 * (`ceo-plans-durable-restart.spec.ts`) spawns the real production
 * `dist/server.js` binary and a dedicated Hall Web dev server, on yet
 * another pair of dedicated ports, for the same reason the two pairs above
 * each use their own: it needs to stop and restart Hall Core mid-test
 * while Hall Web and the browser stay open. `workers: 1` in
 * `playwright.config.ts` means these three durable-restart specs never run
 * concurrently, so the ports only need to be distinct, not exclusively
 * reserved at every instant.
 */
export const CEO_PLANS_DURABLE_RESTART_HALL_CORE_PORT = 4397;
export const CEO_PLANS_DURABLE_RESTART_WEB_PORT = 3097;

/**
 * Phase 15.5 — the CEO plan EXECUTION (not just editing/delegation)
 * clean-restart spec (`ceo-plan-execution-clean-restart.spec.ts`) needs
 * genuinely-completing, deterministic adapters for its delegated child
 * steps — the real production binary only ever registers Mock/Claude
 * Code/Codex (see `durable-restart.spec.ts`'s own doc comment on why),
 * none of which can be scripted to fail/hang/complete on cue the way this
 * spec's workflow requires. So, like `dual-fixture-durable-restart.spec.ts`,
 * this spec spawns `apps/e2e`'s own built `dist/fixture-server.js` (the
 * real `CeoPlanExecutionScheduler`, the real durable stores, the real
 * ownership fence — only the adapter registry differs) via
 * `spawnDurableFixtureHallCore`, on its own dedicated port pair.
 */
export const CLEAN_RESTART_EXECUTION_HALL_CORE_PORT = 4398;
export const CLEAN_RESTART_EXECUTION_WEB_PORT = 3098;

/**
 * Phase 15.5 — the unclean-restart counterpart
 * (`ceo-plan-execution-unclean-restart.spec.ts`), on its own dedicated
 * port pair for the same reason every durable-restart spec in this
 * repository uses one: `workers: 1` means these specs never run
 * concurrently, so the ports only need to be distinct, not exclusively
 * reserved at every instant.
 */
export const UNCLEAN_RESTART_EXECUTION_HALL_CORE_PORT = 4399;
export const UNCLEAN_RESTART_EXECUTION_WEB_PORT = 3099;
