import {
  createMockAgentServerComposition,
  type ServerComposition,
  type ServerCompositionOptions,
} from "./mock-agent-composition-root.js";
import { registerClaudeCodeAdapter } from "./claude-code-composition-root.js";
import { registerCodexAdapter } from "./codex-composition-root.js";

export type { ServerComposition, ServerCompositionOptions };

/**
 * The single Hall Core startup composition entry point. Assembles the
 * stores/orchestrator/buses via `createMockAgentServerComposition` (which
 * remains the only place that knows Mock Agent's own configuration) and
 * then registers Claude Code and Codex on the same `AgentRegistry` via
 * `registerClaudeCodeAdapter`/`registerCodexAdapter` (the only places that
 * know each adapter's own configuration). No adapter-specific composition
 * root knows about any other adapter; this function is the one place
 * that assembles all three onto one shared, provider-neutral registry.
 */
export function createServerComposition(options: ServerCompositionOptions): ServerComposition {
  const composition = createMockAgentServerComposition(options);
  registerClaudeCodeAdapter(composition.registry);
  registerCodexAdapter(composition.registry);
  return composition;
}
