import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { ClaudeCodeAdapter } from "@hall-of-wisdom/claude-code-adapter";

/**
 * The only file in this package allowed to know about the Claude Code
 * adapter specifically — mirrors `mock-agent-composition-root.ts`'s own
 * doc comment for Mock Agent. `TaskOrchestrator`, `TaskStore`,
 * `EventStore`, `EventBus`, and every route module never see this
 * adapter's type, only the generic `AgentAdapter` interface via the
 * shared `AgentRegistry`.
 *
 * Registered unconditionally, with no `--enable-claude-code` startup
 * flag: `ClaudeCodeAdapter.detect()` is itself bounded and safe (a
 * quick, read-only `--version`/`claude auth status` check), so
 * registering the adapter and letting `detect()` report its real
 * availability is the "safe default" the Phase 9 kickoff calls for — a
 * gating flag would only add CLI surface with no corresponding safety
 * benefit. See `docs/architecture/0008-claude-code-adapter.md`,
 * "Trusted server configuration".
 *
 * No provider execution options (executable path, model, permission
 * mode, tool allowlist, environment overrides) are ever accepted here
 * from anything browser- or task-controlled — the adapter's fixed
 * permission profile lives entirely inside
 * `@hall-of-wisdom/claude-code-adapter` itself.
 */
export function registerClaudeCodeAdapter(registry: AgentRegistry): void {
  registry.register(new ClaudeCodeAdapter());
}
