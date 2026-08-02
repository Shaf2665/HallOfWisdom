import { InMemoryCeoPlanRunStore } from "./in-memory-ceo-plan-run-store.js";
import { runCeoPlanRunStoreContractTests } from "./ceo-plan-run-store.contract.js";

runCeoPlanRunStoreContractTests("ephemeral", () => new InMemoryCeoPlanRunStore());
