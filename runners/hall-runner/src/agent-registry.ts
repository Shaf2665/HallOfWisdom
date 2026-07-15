import type { AgentAdapter, AgentAdapterDescriptor } from "@hall-of-wisdom/agent-adapter-sdk";
import { DuplicateAdapterError, UnknownAdapterError } from "./errors.js";

/**
 * Provider-neutral registry of `AgentAdapter` instances, keyed by
 * `descriptor.adapterId`. Stores and returns adapters strictly through the
 * `AgentAdapter` interface — it has no knowledge of Mock Agent, Claude
 * Code, Codex, or any other concrete adapter implementation, and must
 * never be given one.
 */
export class AgentRegistry {
  readonly #adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    const adapterId = adapter.descriptor.adapterId;
    if (this.#adapters.has(adapterId)) {
      throw new DuplicateAdapterError(adapterId);
    }
    this.#adapters.set(adapterId, adapter);
  }

  resolve(adapterId: string): AgentAdapter {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) {
      throw new UnknownAdapterError(adapterId);
    }
    return adapter;
  }

  listDescriptors(): readonly AgentAdapterDescriptor[] {
    return Array.from(this.#adapters.values(), (adapter) => adapter.descriptor);
  }
}
