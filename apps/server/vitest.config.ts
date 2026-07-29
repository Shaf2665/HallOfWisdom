import { defineConfig } from "vitest/config";

/**
 * `src/process-tests/**` is deliberately excluded here — those tests
 * spawn the actual built `dist/server.js` binary as a real OS process,
 * so they can never be part of the default, dist-independent `pnpm test`
 * run (a fresh checkout with no prior `pnpm build` must still pass this
 * command). They run only via `vitest.process.config.ts`, invoked
 * through the dedicated `test:process` script — see that config's doc
 * comment and `docs/architecture/0013-durable-persistence-and-recovery.md`,
 * "Process-level verification."
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "src/process-tests/**"],
    passWithNoTests: false,
    testTimeout: 10000,
  },
});
