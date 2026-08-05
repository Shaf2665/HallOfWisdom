export interface AgentExecutionIsolationDecisionInput {
  readonly adapterId: string;
  readonly hallTaskId: string;
  readonly hallAgentRunId: string;
}

export interface AgentExecutionIsolationPolicy {
  requiresIsolation(input: AgentExecutionIsolationDecisionInput): boolean;
}

export class ExplicitAdapterIsolationPolicy implements AgentExecutionIsolationPolicy {
  readonly #isolatedAdapterIds: ReadonlySet<string>;

  constructor(isolatedAdapterIds: readonly string[]) {
    this.#isolatedAdapterIds = new Set(isolatedAdapterIds);
  }

  requiresIsolation(input: AgentExecutionIsolationDecisionInput): boolean {
    return this.#isolatedAdapterIds.has(input.adapterId);
  }
}

export const noAgentExecutionIsolationPolicy: AgentExecutionIsolationPolicy = {
  requiresIsolation() {
    return false;
  },
};
