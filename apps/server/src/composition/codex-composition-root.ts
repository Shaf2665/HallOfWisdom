import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import { CodexAdapter } from "@hall-of-wisdom/codex-adapter";

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
 */
export function registerCodexAdapter(registry: AgentRegistry): void {
  registry.register(new CodexAdapter());
}
