import { ComparisonStore } from "./comparison-store.js";
import { defineComparisonStoreContractTests } from "./comparison-store-contract.js";

defineComparisonStoreContractTests(
  "in-memory ComparisonStore",
  () => new ComparisonStore({ maxComparisons: 100 }),
);
