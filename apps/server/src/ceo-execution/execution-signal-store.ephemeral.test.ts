import { InMemoryExecutionSignalStore } from "./in-memory-execution-signal-store.js";
import { runExecutionSignalStoreContractTests } from "./execution-signal-store.contract.js";

runExecutionSignalStoreContractTests("ephemeral", () => new InMemoryExecutionSignalStore());
