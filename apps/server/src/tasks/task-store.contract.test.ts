import { TaskStore } from "./task-store.js";
import { defineTaskStoreContractTests } from "./task-store-contract.js";

defineTaskStoreContractTests("in-memory TaskStore", () => new TaskStore({ maxTasks: 100 }));
