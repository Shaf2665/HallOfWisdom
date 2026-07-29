import { EventStore } from "./event-store.js";
import { defineEventStoreContractTests } from "./event-store-contract.js";

defineEventStoreContractTests(
  "in-memory EventStore",
  (maxEventsPerStream = 2000) => new EventStore({ maxEventsPerTask: maxEventsPerStream }),
);
