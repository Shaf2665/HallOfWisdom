import {
  createMockAgentServerComposition,
  type ServerComposition,
  type ServerCompositionOptions,
} from "./mock-agent-composition-root.js";
import { registerClaudeCodeAdapter } from "./claude-code-composition-root.js";
import { registerCodexAdapter } from "./codex-composition-root.js";
import { createComparisonComposition } from "./comparison-composition-root.js";

export type { ServerComposition, ServerCompositionOptions };
export type { ComparisonComposition } from "./comparison-composition-root.js";

/**
 * The single Hall Core startup composition entry point. Assembles the
 * stores/orchestrator/buses via `createMockAgentServerComposition` (which
 * remains the only place that knows Mock Agent's own configuration) and
 * then registers Claude Code and Codex on the same `AgentRegistry` via
 * `registerClaudeCodeAdapter`/`registerCodexAdapter` (the only places that
 * know each adapter's own configuration). No adapter-specific composition
 * root knows about any other adapter; this function is the one place
 * that assembles all three onto one shared, provider-neutral registry.
 *
 * Phase 12 — the multi-agent comparison feature is layered on afterward,
 * only when `options.comparisonRoot` is supplied, reusing the exact same
 * `AgentRegistry` and `TaskStore` this function already built (never a
 * second registry, never a second source of adapters).
 */
export function createServerComposition(options: ServerCompositionOptions): ServerComposition {
  const composition = createMockAgentServerComposition(options);
  registerClaudeCodeAdapter(composition.registry);
  registerCodexAdapter(composition.registry, {
    workspaceRoot: options.workspaceRoot,
    enableCodexTrustedLocal: options.enableCodexTrustedLocal,
  });

  if (options.comparisonRoot === undefined) {
    return composition;
  }

  const comparison = createComparisonComposition({
    registry: composition.registry,
    taskStore: composition.taskStore,
    workspaceRoot: options.workspaceRoot,
    comparisonRoot: options.comparisonRoot,
    limits: options.limits,
    onExecutionError: options.onComparisonExecutionError,
    db: options.db,
  });

  return { ...composition, comparison };
}
