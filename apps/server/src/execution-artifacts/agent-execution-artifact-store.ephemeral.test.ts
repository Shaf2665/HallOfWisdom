import { InMemoryAgentExecutionArtifactStore } from "./in-memory-agent-execution-artifact-store.js";
import { runAgentExecutionArtifactStoreContractTests } from "./agent-execution-artifact-store.contract.js";

runAgentExecutionArtifactStoreContractTests(
  "ephemeral",
  () => new InMemoryAgentExecutionArtifactStore(),
);
