import {
  createMockAgentServerComposition,
  type ServerComposition,
  type ServerCompositionOptions,
} from "./mock-agent-composition-root.js";
import { registerClaudeCodeAdapter } from "./claude-code-composition-root.js";

export type { ServerComposition, ServerCompositionOptions };

/**
 * The single Hall Core startup composition entry point. Assembles the
 * stores/orchestrator/buses via `createMockAgentServerComposition` (which
 * remains the only place that knows Mock Agent's own configuration) and
 * then registers Claude Code on the same `AgentRegistry` via
 * `registerClaudeCodeAdapter` (the only place that knows Claude Code's).
 * Neither adapter-specific composition root knows the other exists;
 * this function is the one place that assembles both onto one shared,
 * provider-neutral registry.
 */
export function createServerComposition(options: ServerCompositionOptions): ServerComposition {
  const composition = createMockAgentServerComposition(options);
  registerClaudeCodeAdapter(composition.registry);
  return composition;
}
