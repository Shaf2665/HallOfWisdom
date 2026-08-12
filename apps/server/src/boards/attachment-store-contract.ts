import { describe, expect, it } from "vitest";
import { AttachmentAlreadyLinkedError, AttachmentNotFoundError } from "../errors/app-error.js";
import type { AttachmentStorePort } from "./attachment-store-port.js";

const NOW = "2026-01-01T00:00:00.000Z";

function pending(overrides: Partial<Parameters<AttachmentStorePort["createPending"]>[0]> = {}) {
  return {
    attachmentId: "11111111-1111-4111-8111-111111111111",
    boardId: "board-1",
    filename: "diagram.png",
    mimeType: "image/png",
    byteSize: 1024,
    kind: "image" as const,
    createdAt: NOW,
    ...overrides,
  };
}

export interface AttachmentStoreContractHarness {
  readonly store: AttachmentStorePort;
  /** Creates a real board row for the durable backend's `attachments.board_id` foreign key; a no-op for the in-memory backend. */
  readonly createBoard: (boardId: string) => void;
}

/**
 * Behavioral contract every `AttachmentStorePort` implementation must
 * satisfy — run once against the in-memory `AttachmentStore` and once
 * against `SqliteAttachmentStore`, mirroring `message-store-contract.ts`'s
 * own pattern. Every test creates `board-1` (and `board-2` where used)
 * before exercising the store, since `board_id` is a real foreign key in
 * the durable backend.
 */
export function defineAttachmentStoreContractTests(
  label: string,
  createHarness: () => AttachmentStoreContractHarness,
): void {
  describe(`AttachmentStorePort contract (${label})`, () => {
    it("resolvePending returns the canonical metadata for a pending attachment", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.createPending(pending());
      const [resolved] = store.resolvePending("board-1", [pending().attachmentId]);
      expect(resolved).toEqual({
        attachmentId: pending().attachmentId,
        filename: "diagram.png",
        mimeType: "image/png",
        byteSize: 1024,
        kind: "image",
      });
    });

    it("resolvePending throws AttachmentNotFoundError for an unknown id", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      expect(() => store.resolvePending("board-1", ["does-not-exist"])).toThrow(
        AttachmentNotFoundError,
      );
    });

    it("resolvePending throws AttachmentNotFoundError for an id belonging to a different board", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      createBoard("board-2");
      store.createPending(pending({ boardId: "board-1" }));
      expect(() => store.resolvePending("board-2", [pending().attachmentId])).toThrow(
        AttachmentNotFoundError,
      );
    });

    it("resolvePending throws AttachmentAlreadyLinkedError for an already-linked id", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.createPending(pending());
      store.link("board-1", [pending().attachmentId], "msg-1");
      expect(() => store.resolvePending("board-1", [pending().attachmentId])).toThrow(
        AttachmentAlreadyLinkedError,
      );
    });

    it("resolvePending is all-or-nothing: one bad id fails the whole batch", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.createPending(pending({ attachmentId: "11111111-1111-4111-8111-111111111111" }));
      expect(() =>
        store.resolvePending("board-1", [
          "11111111-1111-4111-8111-111111111111",
          "does-not-exist",
        ]),
      ).toThrow(AttachmentNotFoundError);
    });

    it("link transitions an attachment from pending to linked", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.createPending(pending());
      expect(store.getLinked("board-1", pending().attachmentId)).toBeUndefined();
      store.link("board-1", [pending().attachmentId], "msg-1");
      expect(store.getLinked("board-1", pending().attachmentId)).toEqual({
        attachmentId: pending().attachmentId,
        filename: "diagram.png",
        mimeType: "image/png",
        byteSize: 1024,
        kind: "image",
      });
    });

    it("link throws AttachmentNotFoundError for an unknown id", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      expect(() => { store.link("board-1", ["does-not-exist"], "msg-1"); }).toThrow(
        AttachmentNotFoundError,
      );
    });

    it("link throws AttachmentNotFoundError for an id belonging to a different board", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      createBoard("board-2");
      store.createPending(pending({ boardId: "board-1" }));
      expect(() => { store.link("board-2", [pending().attachmentId], "msg-1"); }).toThrow(
        AttachmentNotFoundError,
      );
    });

    it("getLinked returns undefined for a still-pending attachment", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.createPending(pending());
      expect(store.getLinked("board-1", pending().attachmentId)).toBeUndefined();
    });

    it("getLinked returns undefined for an unknown attachment", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      expect(store.getLinked("board-1", "does-not-exist")).toBeUndefined();
    });

    it("getLinked returns undefined when boardId does not match, even after linking", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      createBoard("board-2");
      store.createPending(pending({ boardId: "board-1" }));
      store.link("board-1", [pending().attachmentId], "msg-1");
      expect(store.getLinked("board-2", pending().attachmentId)).toBeUndefined();
    });

    it("sweepExpiredPending removes only pending attachments older than the cutoff", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.createPending(
        pending({
          attachmentId: "aaaaaaaa-1111-4111-8111-111111111111",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      store.createPending(
        pending({
          attachmentId: "bbbbbbbb-1111-4111-8111-111111111111",
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
      );
      const swept = store.sweepExpiredPending("2026-01-01T12:00:00.000Z");
      expect(swept).toEqual(["aaaaaaaa-1111-4111-8111-111111111111"]);
      expect(() =>
        store.resolvePending("board-1", ["aaaaaaaa-1111-4111-8111-111111111111"]),
      ).toThrow(AttachmentNotFoundError);
      expect(() =>
        store.resolvePending("board-1", ["bbbbbbbb-1111-4111-8111-111111111111"]),
      ).not.toThrow();
    });

    it("sweepExpiredPending never removes a linked attachment, no matter how old", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.createPending(pending({ createdAt: "2020-01-01T00:00:00.000Z" }));
      store.link("board-1", [pending().attachmentId], "msg-1");
      const swept = store.sweepExpiredPending("2030-01-01T00:00:00.000Z");
      expect(swept).toEqual([]);
      expect(store.getLinked("board-1", pending().attachmentId)).toBeDefined();
    });

    it("sweepExpiredPending returns an empty array when nothing is eligible", () => {
      const { store, createBoard } = createHarness();
      createBoard("board-1");
      store.createPending(pending());
      expect(store.sweepExpiredPending("2020-01-01T00:00:00.000Z")).toEqual([]);
    });
  });
}
