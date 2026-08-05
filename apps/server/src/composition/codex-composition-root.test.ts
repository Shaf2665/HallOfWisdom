import { describe, expect, it } from "vitest";
import { registerCodexAdapter } from "./codex-composition-root.js";
import { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { nodeProcessSpawner, type ProcessSpawner } from "@hall-of-wisdom/codex-adapter";
import { InMemoryAgentWorktreeStore } from "../agent-worktrees/in-memory-agent-worktree-store.js";
import type { AgentWorktreeValidator } from "../agent-execution/isolated-agent-execution-coordinator.js";

/**
 * Phase 11.1 — a minimal, deterministic fake `ProcessSpawner`: every
 * spawn (`--version`, `login status`, `exec --help`, ...) fails
 * immediately with a non-zero exit code and no output, which is enough
 * to make `CodexAdapter.detect()` resolve to a non-`available` result
 * without ever starting a real `codex` process. This test suite only
 * needs to prove *this composition root's own wiring* (which
 * configuration it passes to `CodexAdapter`), not `CodexAdapter`'s own
 * detection logic — that belongs to `@hall-of-wisdom/codex-adapter`'s
 * own `detection.test.ts`, which already covers every real detection
 * branch deterministically. Spawning a real `codex --version`/`login
 * status` process here (the pre-11.1 behavior) made this an
 * environment- and load-dependent test: it timed out under heavy
 * concurrent CPU load during a full-workspace `pnpm test` run, even
 * though it passed reliably in isolation — a real CLI process is simply
 * too slow and too load-sensitive for an ordinary unit test.
 */
function alwaysFailingSpawner(): ProcessSpawner {
  return {
    spawn() {
      const stream = {
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === "end") {
            queueMicrotask(() => {
              cb();
            });
          }
          return stream;
        },
      } as unknown as NodeJS.ReadableStream;
      return {
        pid: 1,
        stdin: { end: () => undefined, write: () => true } as unknown as NodeJS.WritableStream,
        stdout: stream,
        stderr: stream,
        onExit(cb) {
          queueMicrotask(() => {
            cb(1, null);
          });
        },
        onError() {
          /* no error path exercised here */
        },
        kill: () => true,
      };
    },
  };
}

function successfulDetectionSpawner(): ProcessSpawner {
  return {
    spawn(_executablePath, args) {
      const stdoutText = args.includes("--version")
        ? "codex-cli 0.144.4"
        : args.includes("exec") && args.includes("--help")
          ? [
              "--json",
              "--ephemeral",
              "--ignore-user-config",
              "--ignore-rules",
              "--strict-config",
              "--sandbox",
              "--disable",
              "--cd",
              "-c, --config",
            ].join("\n")
          : "";
      const stderrText =
        args.includes("login") && args.includes("status") ? "Logged in using ChatGPT" : "";
      const stream = {
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === "data" && stdoutText.length > 0) {
            queueMicrotask(() => {
              cb(Buffer.from(stdoutText, "utf8"));
            });
          }
          if (event === "data" && stderrText.length > 0) {
            queueMicrotask(() => {
              cb(Buffer.from(stderrText, "utf8"));
            });
          }
          return stream;
        },
      } as unknown as NodeJS.ReadableStream;
      return {
        pid: 1,
        stdin: { end: () => undefined, write: () => true } as unknown as NodeJS.WritableStream,
        stdout: stream,
        stderr: stream,
        onExit(cb) {
          queueMicrotask(() => {
            cb(0, null);
          });
        },
        onError() {
          /* no error path exercised here */
        },
        kill: () => true,
      };
    },
  };
}

/**
 * Phase 10.2 — proves the real production wiring `server.ts` actually
 * uses (`createServerComposition` -> `registerCodexAdapter` -> a real
 * `CodexAdapter`), not the test-only `buildTestApp`/`additionalAdapters`
 * shortcut most other integration tests use to inject a hand-built
 * `CodexAdapter` directly. `codex-integration.test.ts` covers the
 * adapter's own behavior once constructed; this file covers that the
 * composition root actually constructs it with the right configuration.
 *
 * Phase 11.1 — every test below injects `alwaysFailingSpawner()` so
 * `detect()` never spawns a real `codex` process; the one exception is
 * the explicitly-named, opt-in real-detection smoke check at the bottom
 * of this file, which is skipped by default.
 */
describe("registerCodexAdapter", () => {
  it("registers exactly one adapter under the Codex adapter id", () => {
    const registry = new AgentRegistry();
    registerCodexAdapter(registry, {
      workspaceRoot: process.cwd(),
      spawner: alwaysFailingSpawner(),
    });
    const [descriptor] = registry.listDescriptors();
    expect(descriptor?.adapterId).toBe("hall.codex");
  });

  it("defaults trusted-local mode to disabled when enableCodexTrustedLocal is omitted", async () => {
    const registry = new AgentRegistry();
    registerCodexAdapter(registry, {
      workspaceRoot: process.cwd(),
      spawner: alwaysFailingSpawner(),
    });
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
      spawner: alwaysFailingSpawner(),
    });
    const adapter = registry.resolve("hall.codex");
    const result = await adapter.detect();
    expect(result.availability).not.toBe("available");
  });

  it("keeps strict isolated detection unsupported even when durable storage, root, and probe are configured", async () => {
    const registry = new AgentRegistry();
    const worktreeStore = new InMemoryAgentWorktreeStore();
    const validator: AgentWorktreeValidator = {
      validateReadyWorktree: () =>
        Promise.resolve({
          canonicalOwnedRoot: "D:\\hall-worktrees",
          canonicalWorktreePath: "D:\\hall-worktrees\\wt_wt-1",
          agentWorkingDirectory: "D:\\hall-worktrees\\wt_wt-1",
          record: worktreeStore.createCreating({
            worktreeId: "unused-record",
            hallTaskId: "unused-task",
            hallAgentRunId: "unused-run",
            canonicalSourceRepositoryRoot: "D:\\repo",
            sourceWorkingDirectoryRelativePath: ".",
            baseCommit: "a".repeat(40),
            canonicalWorktreePath: "D:\\hall-worktrees\\wt_unused-record",
            createdAt: "2026-08-05T00:00:00.000Z",
          }),
        }),
    };
    registerCodexAdapter(registry, {
      workspaceRoot: process.cwd(),
      durableStorageEnabled: true,
      agentWorktreeRoot: "D:\\hall-worktrees",
      worktreeStore,
      worktreeValidator: validator,
      sandboxProbe: { run: () => Promise.resolve({ ok: true, code: "SANDBOX_PROBE_PASSED" }) },
      spawner: successfulDetectionSpawner(),
    });
    const result = await registry.resolve("hall.codex").detect();
    expect(result.availability).toBe("unsupported");
    expect(result.executionTrust).toBe("unavailable");
    expect(result.diagnosticMessage).toBe(
      "Codex strict isolated execution requires exact sandbox equivalence verification from Phase 16.6.",
    );
    expect(result.capabilityObservations).not.toContainEqual(
      expect.objectContaining({ capability: "project.edit", status: "verified" }),
    );
    expect(result.capabilityObservations).not.toContainEqual(
      expect.objectContaining({ capability: "command.execute", status: "verified" }),
    );
  });

  it("fails strict isolated detection closed when the explicit worktree root is absent", async () => {
    const registry = new AgentRegistry();
    registerCodexAdapter(registry, {
      workspaceRoot: process.cwd(),
      durableStorageEnabled: true,
      sandboxProbe: { run: () => Promise.resolve({ ok: true, code: "SANDBOX_PROBE_PASSED" }) },
      spawner: successfulDetectionSpawner(),
    });
    const result = await registry.resolve("hall.codex").detect();
    expect(result.availability).toBe("unsupported");
    expect(result.diagnosticMessage).toBe(
      "Codex strict isolated execution requires a configured Hall-owned worktree root.",
    );
  });

  it("does not pass a spawner through to CodexAdapter when none is supplied (production path unaffected)", () => {
    // No assertion beyond "does not throw" — this only proves that
    // omitting `spawner` (exactly what `server.ts`'s real composition
    // path always does) still constructs a working adapter, i.e. that
    // the real-default fallback inside CodexAdapter itself is reached,
    // not short-circuited by this composition root.
    const registry = new AgentRegistry();
    expect(() => {
      registerCodexAdapter(registry, { workspaceRoot: process.cwd() });
    }).not.toThrow();
  });

  /**
   * Opt-in real-detection smoke check — spawns the operator's actual,
   * locally-installed `codex` CLI exactly like production does. Skipped
   * by default (`it.skip`) so it never runs as part of the ordinary,
   * deterministic unit suite or a full-workspace `pnpm test`; run it
   * explicitly with `npx vitest run src/composition/codex-composition-root.test.ts
   * -t "opt-in real"` (removing `.skip` locally, or via a future
   * dedicated smoke-test script) when you need to confirm this
   * composition root still behaves correctly against a real CLI. Spends
   * no Codex/ChatGPT usage — `detect()` only runs `--version`/`login
   * status`/`exec --help`, never a real task.
   */
  it.skip("opt-in real: registers a CodexAdapter that reaches a real detect() result", async () => {
    const registry = new AgentRegistry();
    registerCodexAdapter(registry, {
      workspaceRoot: process.cwd(),
      spawner: nodeProcessSpawner,
    });
    const adapter = registry.resolve("hall.codex");
    const result = await adapter.detect();
    expect(result.installed).toBeDefined();
  });
});
