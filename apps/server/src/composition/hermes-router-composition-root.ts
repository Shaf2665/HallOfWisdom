import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import {
  HermesRouterAdapter,
  type HermesRouterAdapterConfig,
} from "@hall-of-wisdom/hermes-router-adapter";

export interface RegisterHermesRouterAdapterOptions {
  /** Test-only injection; production always uses the Hall Core process environment and real probes. */
  readonly adapterConfig?: HermesRouterAdapterConfig | undefined;
}

/** Registers Hermes while detection keeps it non-assignable to Hall routing. */
export function registerHermesRouterAdapter(
  registry: AgentRegistry,
  options: RegisterHermesRouterAdapterOptions = {},
): void {
  registry.register(new HermesRouterAdapter(options.adapterConfig));
}
