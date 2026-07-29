import { MessageStore } from "./message-store.js";
import { defineMessageStoreContractTests } from "./message-store-contract.js";

defineMessageStoreContractTests("in-memory MessageStore", (maxMessagesPerBoard = 1000) => ({
  store: new MessageStore({ maxMessagesPerBoard }),
  createBoard: () => {
    // The in-memory MessageStore tracks board existence purely through
    // registerBoard() — nothing to pre-create.
  },
}));
