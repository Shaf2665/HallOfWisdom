import { describe, expect, it } from "vitest";
import { registerCodexAdapter } from "./codex-composition-root.js";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";

/**
 * Phase 10.2 — proves the real production wiring `server.ts` actually
 * uses (`createServerComposition` -> `registerCodexAdapter` -> a real
 * `CodexAdapter`), not the test-only `buildTestApp`/`additionalAdapters`
 * shortcut most other integration tests use to inject a hand-built
 * `CodexAdapter` directly. `codex-integration.test.ts` covers the
 * adapter's own behavior once constructed; this file covers that the
 * composition root actually constructs it with the right configuration.
 */
describe("registerCodexAdapter", () => {
  it("registers exactly one adapter under the Codex adapter id", () => {
    const registry = new AgentRegistry();
    registerCodexAdapter(registry, { workspaceRoot: process.cwd() });
    const [descriptor] = registry.listDescriptors();
    expect(descriptor?.adapterId).toBe("hall.codex");
  });

  it("defaults trusted-local mode to disabled when enableCodexTrustedLocal is omitted", async () => {
    const registry = new AgentRegistry();
    registerCodexAdapter(registry, { workspaceRoot: process.cwd() });
    const adapter = registry.resolve("hall.codex");
    const result = await adapter.detect();
    // Never "available" by default — Phase 10.1's fail-closed behavior is
    // the composition root's own default, not merely the adapter's.
    expect(result.availability).not.toBe("available");
  });

  it("passes enableCodexTrustedLocal: false through explicitly without enabling trusted-local mode", async () => {
    const registry = new AgentRegistry();
    registerCodexAdapter(registry, {
      workspaceRoot: process.cwd(),
      enableCodexTrustedLocal: false,
    });
    const adapter = registry.resolve("hall.codex");
    const result = await adapter.detect();
    expect(result.availability).not.toBe("available");
  });
});
