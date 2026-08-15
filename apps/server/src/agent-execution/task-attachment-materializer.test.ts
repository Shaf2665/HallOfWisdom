import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommunicationMessage, MessageAttachment } from "@hall-of-wisdom/protocol";
import { MAX_TASK_ATTACHMENTS, MAX_TASK_ATTACHMENTS_TOTAL_BYTES } from "@hall-of-wisdom/agent-adapter-sdk";
import type { BoardStorePort } from "../boards/board-store-port.js";
import type { MessageStorePort } from "../boards/message-store-port.js";
import { AttachmentBlobStore } from "../boards/attachment-blob-store.js";
import {
  AttachmentBlobUnavailableError,
  AttachmentMaterializationLimitExceededError,
} from "./agent-execution-errors.js";
import { HALL_ATTACHMENTS_DIRNAME, HallTaskAttachmentMaterializer } from "./task-attachment-materializer.js";

const TASK_ID = "task-1";
const BOARD_ID = `task:${TASK_ID}`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hall-attachment-materializer-"));
  tempDirs.push(dir);
  return dir;
}

function attachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    attachmentId: "11111111-1111-4111-8111-111111111111",
    filename: "notes.txt",
    mimeType: "text/plain",
    byteSize: 5,
    kind: "file",
    ...overrides,
  };
}

/** A minimal, fully controllable double — not the real `BoardStore`/`MessageStore` — so a test can plant a system-authored message with attachments, something the real HTTP-facing stores never allow a caller to construct. */
class FakeBoardStore implements BoardStorePort {
  constructor(private readonly existingBoardIds: ReadonlySet<string>) {}
  has(boardId: string): boolean {
    return this.existingBoardIds.has(boardId);
  }
  seedGeneralBoard(): never {
    throw new Error("unused");
  }
  get(): never {
    throw new Error("unused");
  }
  list(): never {
    throw new Error("unused");
  }
  ensureTaskBoard(): never {
    throw new Error("unused");
  }
  recordMessageAppended(): never {
    throw new Error("unused");
  }
}

class FakeMessageStore implements MessageStorePort {
  constructor(private readonly messages: readonly CommunicationMessage[]) {}
  list(): CommunicationMessage[] {
    return [...this.messages];
  }
  registerBoard(): never {
    throw new Error("unused");
  }
  append(): never {
    throw new Error("unused");
  }
  nextSequence(): never {
    throw new Error("unused");
  }
}

function message(overrides: Partial<CommunicationMessage> = {}): CommunicationMessage {
  return {
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    boardId: BOARD_ID,
    sequence: 0,
    author: { kind: "human", displayName: "Ada" },
    text: "here you go",
    createdAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

function buildMaterializer(
  boardIds: readonly string[],
  messages: readonly CommunicationMessage[],
  blobStore: AttachmentBlobStore,
): HallTaskAttachmentMaterializer {
  return new HallTaskAttachmentMaterializer({
    boardStore: new FakeBoardStore(new Set(boardIds)),
    messageStore: new FakeMessageStore(messages),
    blobStore,
  });
}

describe("HallTaskAttachmentMaterializer.snapshotAttachments", () => {
  it("returns an empty snapshot when the task has no board at all", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const materializer = buildMaterializer([], [], blobStore);
    expect(materializer.snapshotAttachments(TASK_ID)).toEqual({ attachments: [] });
  });

  it("returns an empty snapshot when the board exists but has no attachments", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const materializer = buildMaterializer(
      [BOARD_ID],
      [message({ text: "just chatting" })],
      blobStore,
    );
    expect(materializer.snapshotAttachments(TASK_ID)).toEqual({ attachments: [] });
  });

  it("collects attachments from human messages, across multiple messages", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const a = attachment({ attachmentId: "11111111-1111-4111-8111-111111111111", filename: "a.txt" });
    const b = attachment({ attachmentId: "22222222-2222-4222-8222-222222222222", filename: "b.txt" });
    const materializer = buildMaterializer(
      [BOARD_ID],
      [
        message({ sequence: 0, text: "first", attachments: [a] }),
        message({ sequence: 1, text: "second", attachments: [b] }),
      ],
      blobStore,
    );
    expect(materializer.snapshotAttachments(TASK_ID).attachments).toEqual([a, b]);
  });

  it("excludes attachments from non-human (system) messages", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const systemAttachment = attachment({ filename: "should-not-appear.txt" });
    const materializer = buildMaterializer(
      [BOARD_ID],
      [
        message({
          author: { kind: "system", displayName: "Hall CEO" },
          text: "plan created",
          attachments: [systemAttachment],
        }),
      ],
      blobStore,
    );
    expect(materializer.snapshotAttachments(TASK_ID).attachments).toEqual([]);
  });
});

describe("HallTaskAttachmentMaterializer.materializeSnapshot", () => {
  it("returns an empty manifest and writes nothing for an empty snapshot", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const materializer = buildMaterializer([], [], blobStore);
    const workingDirectory = makeTempDir();
    expect(materializer.materializeSnapshot({ attachments: [] }, workingDirectory)).toEqual([]);
    expect(fs.existsSync(path.join(workingDirectory, HALL_ATTACHMENTS_DIRNAME))).toBe(false);
  });

  it("writes each attachment under .hall-attachments/<id>/<filename> and returns a matching manifest", () => {
    const blobRoot = makeTempDir();
    const blobStore = new AttachmentBlobStore({ rootDir: blobRoot });
    const a = attachment({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "notes.txt",
      mimeType: "text/plain",
      kind: "file",
    });
    blobStore.write(a.attachmentId, Buffer.from("hello world"));
    const materializer = buildMaterializer([BOARD_ID], [], blobStore);
    const workingDirectory = makeTempDir();

    const manifest = materializer.materializeSnapshot({ attachments: [a] }, workingDirectory);

    const expectedRelativePath = `${HALL_ATTACHMENTS_DIRNAME}/${a.attachmentId}/notes.txt`;
    expect(manifest).toEqual([
      { relativePath: expectedRelativePath, filename: "notes.txt", mimeType: "text/plain", kind: "file" },
    ]);
    expect(fs.readFileSync(path.join(workingDirectory, expectedRelativePath), "utf8")).toBe(
      "hello world",
    );
  });

  it("materializes multiple attachments independently", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const a = attachment({ attachmentId: "11111111-1111-4111-8111-111111111111", filename: "a.txt" });
    const b = attachment({
      attachmentId: "22222222-2222-4222-8222-222222222222",
      filename: "b.png",
      mimeType: "image/png",
      kind: "image",
    });
    blobStore.write(a.attachmentId, Buffer.from("A"));
    blobStore.write(b.attachmentId, Buffer.from("B"));
    const materializer = buildMaterializer([BOARD_ID], [], blobStore);
    const workingDirectory = makeTempDir();

    const manifest = materializer.materializeSnapshot({ attachments: [a, b] }, workingDirectory);

    expect(manifest).toHaveLength(2);
    expect(manifest.map((entry) => entry.filename).sort()).toEqual(["a.txt", "b.png"]);
    for (const entry of manifest) {
      expect(fs.existsSync(path.join(workingDirectory, entry.relativePath))).toBe(true);
    }
  });

  it("fails clearly, without writing anything, when the attachment count exceeds the cap", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const many = Array.from({ length: MAX_TASK_ATTACHMENTS + 1 }, (_, index) =>
      attachment({
        attachmentId: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
        filename: `file-${String(index)}.txt`,
      }),
    );
    const materializer = buildMaterializer([BOARD_ID], [], blobStore);
    const workingDirectory = makeTempDir();

    expect(() => materializer.materializeSnapshot({ attachments: many }, workingDirectory)).toThrow(
      AttachmentMaterializationLimitExceededError,
    );
    expect(fs.existsSync(path.join(workingDirectory, HALL_ATTACHMENTS_DIRNAME))).toBe(false);
  });

  it("fails clearly, without writing anything, when the total byte size exceeds the cap", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const huge = attachment({ byteSize: MAX_TASK_ATTACHMENTS_TOTAL_BYTES + 1 });
    const materializer = buildMaterializer([BOARD_ID], [], blobStore);
    const workingDirectory = makeTempDir();

    expect(() => materializer.materializeSnapshot({ attachments: [huge] }, workingDirectory)).toThrow(
      AttachmentMaterializationLimitExceededError,
    );
    expect(fs.existsSync(path.join(workingDirectory, HALL_ATTACHMENTS_DIRNAME))).toBe(false);
  });

  it("fails clearly when a linked attachment's blob is missing", () => {
    // Never written to blobStore — simulates a missing/corrupt blob.
    const orphaned = attachment({ attachmentId: "33333333-3333-4333-8333-333333333333" });
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const materializer = buildMaterializer([BOARD_ID], [], blobStore);
    const workingDirectory = makeTempDir();

    expect(() =>
      materializer.materializeSnapshot({ attachments: [orphaned] }, workingDirectory),
    ).toThrow(AttachmentBlobUnavailableError);
  });
});
