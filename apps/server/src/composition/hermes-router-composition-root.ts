import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  HermesRouterAdapter,
  type HermesRouterAdapterConfig,
} from "@hall-of-wisdom/hermes-router-adapter";

export interface RegisterHermesRouterAdapterOptions {
  /** Set only by trusted server composition after shared durable worktree services are ready. */
  readonly isolatedExecutionEnabled?: boolean | undefined;
  /** Test-only injection; production always uses the Hall Core process environment and real probes. */
  readonly adapterConfig?: Omit<HermesRouterAdapterConfig, "isolatedExecutionEnabled"> | undefined;
}

/** Registers Hermes with availability gated by Hall's trusted durable-isolation composition. */
export function registerHermesRouterAdapter(
  registry: AgentRegistry,
  options: RegisterHermesRouterAdapterOptions = {},
): void {
  registry.register(
    new HermesRouterAdapter({
      ...options.adapterConfig,
      isolatedExecutionEnabled: options.isolatedExecutionEnabled === true,
    }),
  );
}
