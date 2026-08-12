import { AttachmentStore } from "./attachment-store.js";
import { defineAttachmentStoreContractTests } from "./attachment-store-contract.js";

defineAttachmentStoreContractTests("in-memory AttachmentStore", () => ({
  store: new AttachmentStore(),
  createBoard: () => {
    // The in-memory AttachmentStore has no board foreign key to satisfy — nothing to pre-create.
  },
}));
