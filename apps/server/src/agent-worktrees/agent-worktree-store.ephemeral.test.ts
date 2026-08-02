import { InMemoryAgentWorktreeStore } from "./in-memory-agent-worktree-store.js";
import { runAgentWorktreeStoreContractTests } from "./agent-worktree-store.contract.js";

runAgentWorktreeStoreContractTests("ephemeral", () => new InMemoryAgentWorktreeStore());
