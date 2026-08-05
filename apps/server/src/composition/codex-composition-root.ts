import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  CODEX_ADAPTER_ID,
  CodexAdapter,
  realCodexSandboxCompatibilityProbe,
  type CodexSandboxCompatibilityProbe,
  type CodexStrictWorktreeValidator,
  type ProcessSpawner,
} from "@hall-of-wisdom/codex-adapter";
import type { AgentWorktreeValidator } from "../agent-execution/isolated-agent-execution-coordinator.js";
import type { AgentWorktreeStorePort } from "../agent-worktrees/agent-worktree-store-port.js";
import { samePath } from "../agent-worktrees/path-safety.js";

export interface RegisterCodexAdapterOptions {
  /** Canonical, already-validated Hall Core workspace root. */
  readonly workspaceRoot: string;
  readonly durableStorageEnabled?: boolean | undefined;
  readonly agentWorktreeRoot?: string | undefined;
  readonly worktreeStore?: AgentWorktreeStorePort | undefined;
  readonly worktreeValidator?: AgentWorktreeValidator | undefined;
  readonly sandboxProbe?: CodexSandboxCompatibilityProbe | undefined;
  /** `--enable-codex-trusted-local` at Hall Core startup only. Defaults to false. */
  readonly enableCodexTrustedLocal?: boolean | undefined;
  /**
   * Test-only injection point — never set by `server.ts` or any real
   * composition path, which always leaves this `undefined` so
   * `CodexAdapter` falls back to its own real, `cross-spawn`-backed
   * default. Exists so `codex-composition-root.test.ts` can prove this
   * composition root wires `CodexAdapter`'s configuration correctly
   * (trusted-local defaulting, flag pass-through) without spawning a
   * real `codex` process — see that file's own doc comment.
   */
  readonly spawner?: ProcessSpawner | undefined;
}

/**
 * The only file in this package allowed to know about the Codex adapter
 * specifically — mirrors `claude-code-composition-root.ts`'s own doc
 * comment. `TaskOrchestrator`, `TaskStore`, `EventStore`, `EventBus`, and
 * every route module never see this adapter's type, only the generic
 * `AgentAdapter` interface via the shared `AgentRegistry`.
 *
 * Registered unconditionally, with no `--enable-codex` startup flag:
 * `CodexAdapter.detect()` is itself bounded and safe (a quick, read-only
 * `--version`/`login status`/`--help` check), so registering the adapter
 * and letting `detect()` report its real availability is the same "safe
 * default" the Claude Code adapter already uses. A Codex detection
 * failure never breaks Mock Agent or Claude Code's own registration.
 *
 * No provider execution options (executable path, sandbox mode, model,
 * environment overrides) are ever accepted here from anything browser- or
 * task-controlled — the adapter's fixed sandbox profile lives entirely
 * inside `@hall-of-wisdom/codex-adapter` itself.
 *
 * Phase 10.2 — `trustedLocal.loopbackBound` is hard-coded `true` here, not
 * threaded from anywhere configurable: `server.ts` always calls
 * `app.listen({ host: LOCAL_ONLY_HOST })` (`127.0.0.1`), and there is
 * deliberately no CLI flag to change that in this phase (see
 * `server-config.ts`'s own doc comment on `LOCAL_ONLY_HOST`). This
 * constant import, not a boolean parameter, is what keeps that fact tied
 * to its one real source rather than letting a caller assert it
 * independently.
 */
export function registerCodexAdapter(
  registry: AgentRegistry,
  options: RegisterCodexAdapterOptions,
): void {
  const strictValidator = buildStrictWorktreeValidator(
    options.worktreeStore,
    options.worktreeValidator,
  );
  const strictRootReady =
    options.agentWorktreeRoot !== undefined && options.agentWorktreeRoot !== "";
  registry.register(
    new CodexAdapter({
      trustedLocal: {
        enabled: options.enableCodexTrustedLocal ?? false,
        // `server.ts` always calls `app.listen({ host: LOCAL_ONLY_HOST })` —
        // true unconditionally in this phase, not derived from any runtime
        // check (see the module doc comment above and `LOCAL_ONLY_HOST`'s
        // own doc comment in server-config.ts).
        loopbackBound: true,
        workspaceRoot: options.workspaceRoot,
      },
      strictIsolation: {
        enabled: options.enableCodexTrustedLocal !== true,
        durableStorage: options.durableStorageEnabled === true,
        worktreeRoot: options.agentWorktreeRoot ?? "",
        worktreeRootReady: strictRootReady,
        validatorAvailable: strictValidator !== undefined,
        sandboxProbe: options.sandboxProbe ?? realCodexSandboxCompatibilityProbe,
        validateWorktree: strictValidator,
      },
      ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
    }),
  );
}

function buildStrictWorktreeValidator(
  store: AgentWorktreeStorePort | undefined,
  validator: AgentWorktreeValidator | undefined,
): CodexStrictWorktreeValidator | undefined {
  if (store === undefined || validator === undefined) return undefined;
  return async (input) => {
    if (input.adapterId !== CODEX_ADAPTER_ID) return { ok: false };
    const record = store.findActiveByAgentRunId(input.hallAgentRunId);
    if (
      record?.hallTaskId !== input.hallTaskId ||
      record.hallAgentRunId !== input.hallAgentRunId ||
      record.status !== "ready" ||
      (input.expectedWorktreeId !== undefined && record.worktreeId !== input.expectedWorktreeId)
    ) {
      return { ok: false };
    }
    const handle = await validator.validateReadyWorktree({
      hallTaskId: input.hallTaskId,
      hallAgentRunId: input.hallAgentRunId,
      requireHeadAtBase: true,
      signal: input.signal,
      worktreeId: record.worktreeId,
    });
    const ok = samePath(handle.agentWorkingDirectory, input.workingDirectory);
    return { ok, ...(ok ? { worktreeId: record.worktreeId } : {}) };
  };
}
