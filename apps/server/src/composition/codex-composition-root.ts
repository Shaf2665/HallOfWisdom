import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { CodexAdapter } from "@hall-of-wisdom/codex-adapter";

export interface RegisterCodexAdapterOptions {
  /** Canonical, already-validated Hall Core workspace root. */
  readonly workspaceRoot: string;
  /** `--enable-codex-trusted-local` at Hall Core startup only. Defaults to false. */
  readonly enableCodexTrustedLocal?: boolean | undefined;
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
    }),
  );
}
