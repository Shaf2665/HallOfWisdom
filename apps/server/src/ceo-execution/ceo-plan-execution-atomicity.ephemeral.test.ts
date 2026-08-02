import { createEphemeralAtomicUnit } from "../ceo-plans/ephemeral-atomic-unit.js";
import { InMemoryCeoPlanRunStore } from "./in-memory-ceo-plan-run-store.js";
import { InMemoryExecutionSignalStore } from "./in-memory-execution-signal-store.js";
import {
  buildExecutionAtomicityHarnessDeps,
  runCeoPlanExecutionAtomicityContractTests,
} from "./ceo-plan-execution-atomicity.contract.js";

runCeoPlanExecutionAtomicityContractTests("ephemeral", (adapter) => {
  const planRunStore = new InMemoryCeoPlanRunStore();
  const signalStore = new InMemoryExecutionSignalStore();
  const runAtomicUnit = createEphemeralAtomicUnit({ planRunStore, signalStore });
  return buildExecutionAtomicityHarnessDeps(planRunStore, signalStore, runAtomicUnit, adapter);
});
