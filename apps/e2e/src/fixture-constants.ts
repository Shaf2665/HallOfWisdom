/**
 * Side-effect-free constants shared between `fixture-server.ts` (the
 * standalone process Playwright's `webServer` config spawns) and Playwright
 * spec files. Deliberately its own module: `fixture-server.ts` has a
 * top-level, unguarded `main().catch(...)` call that starts a full Hall
 * Core server as an import side effect — a spec file importing anything
 * from `fixture-server.ts` directly would trigger that side effect a
 * second time inside the Playwright test-runner process itself, racing
 * the one Playwright's own `webServer` config already started for
 * `127.0.0.1:4310` (observed as `EADDRINUSE`, twice per run — once during
 * test collection, once during execution — even though the suite still
 * passes by reusing the first, legitimate instance).
 */
export const E2E_SOURCE_REPO_RELATIVE_DIR = "source-repo";
