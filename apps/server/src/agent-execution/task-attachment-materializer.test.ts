import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommunicationMessage, MessageAttachment } from "@hall-of-wisdom/protocol";
import {
  MAX_TASK_ATTACHMENTS,
  MAX_TASK_ATTACHMENTS_TOTAL_BYTES,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { BoardStorePort } from "../boards/board-store-port.js";
import type { MessageStorePort } from "../boards/message-store-port.js";
import { AttachmentBlobStore } from "../boards/attachment-blob-store.js";
import type { CeoPlanStorePort } from "../ceo-plans/ceo-plan-store-port.js";
import {
  AttachmentBlobUnavailableError,
  AttachmentMaterializationLimitExceededError,
} from "./agent-execution-errors.js";
import {
  HALL_ATTACHMENTS_DIRNAME,
  HallTaskAttachmentMaterializer,
  type HallTaskAttachmentMaterializerOptions,
} from "./task-attachment-materializer.js";

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
  list(boardId: string): CommunicationMessage[] {
    return this.messages.filter((message) => message.boardId === boardId);
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
  extra: Partial<HallTaskAttachmentMaterializerOptions> = {},
): HallTaskAttachmentMaterializer {
  return new HallTaskAttachmentMaterializer({
    boardStore: new FakeBoardStore(new Set(boardIds)),
    messageStore: new FakeMessageStore(messages),
    blobStore,
    ...extra,
  });
}

/** A minimal, fully controllable `CeoPlanStorePort` double — only `findPlanIdByChildTaskId` and `getPlan` are ever called by the materializer; every other method is unused by this test suite. */
class FakeCeoPlanStore implements CeoPlanStorePort {
  constructor(
    private readonly childTaskToPlan: ReadonlyMap<string, { planId: string; parentTaskId: string }>,
  ) {}
  findPlanIdByChildTaskId(childTaskId: string): string | undefined {
    return this.childTaskToPlan.get(childTaskId)?.planId;
  }
  getPlan(planId: string): ReturnType<CeoPlanStorePort["getPlan"]> {
    const entry = [...this.childTaskToPlan.values()].find((v) => v.planId === planId);
    if (entry === undefined) throw new Error(`no plan ${planId}`);
    // Only `.parentTaskId` is ever read by the materializer — a bare cast
    // (rather than a full `CeoPlan` fixture) keeps this double honest
    // about which one field it actually needs to support.
    return { parentTaskId: entry.parentTaskId } as ReturnType<CeoPlanStorePort["getPlan"]>;
  }
  createPlan(): never {
    throw new Error("unused");
  }
  createVersion(): never {
    throw new Error("unused");
  }
  submit(): never {
    throw new Error("unused");
  }
  decideApproval(): never {
    throw new Error("unused");
  }
  cancel(): never {
    throw new Error("unused");
  }
  deletePlan(): never {
    throw new Error("unused");
  }
  recordDelegation(): never {
    throw new Error("unused");
  }
  syncProgress(): never {
    throw new Error("unused");
  }
  listPlans(): never {
    throw new Error("unused");
  }
  listPlansForParentTask(): never {
    throw new Error("unused");
  }
  getVersion(): never {
    throw new Error("unused");
  }
  listVersions(): never {
    throw new Error("unused");
  }
  listApprovals(): never {
    throw new Error("unused");
  }
  listDelegationLinks(): never {
    throw new Error("unused");
  }
  getRevision(): never {
    throw new Error("unused");
  }
  getLastProgressFingerprint(): never {
    throw new Error("unused");
  }
  appendEvent(): never {
    throw new Error("unused");
  }
  listEvents(): never {
    throw new Error("unused");
  }
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
    const a = attachment({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "a.txt",
    });
    const b = attachment({
      attachmentId: "22222222-2222-4222-8222-222222222222",
      filename: "b.txt",
    });
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

describe("HallTaskAttachmentMaterializer — CEO plan attachment inheritance (Issue #23)", () => {
  const CHILD_TASK_ID = "child-task-1";
  const CHILD_BOARD_ID = `task:${CHILD_TASK_ID}`;
  const PARENT_TASK_ID = "parent-task-1";
  const PARENT_BOARD_ID = `task:${PARENT_TASK_ID}`;
  const PLAN_ID = "plan-1";

  it("a direct (non-CEO) task's snapshot is unaffected by an unrelated getCeoPlanStore — own board only", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const a = attachment({ attachmentId: "11111111-1111-4111-8111-111111111111" });
    const planStore = new FakeCeoPlanStore(new Map()); // no delegation link for this task at all
    const materializer = buildMaterializer([BOARD_ID], [message({ attachments: [a] })], blobStore, {
      getCeoPlanStore: () => planStore,
    });
    expect(materializer.snapshotAttachments(TASK_ID).attachments).toEqual([a]);
  });

  it("a delegated child task inherits its CEO plan's parent task's own human attachments", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const parentAttachment = attachment({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "screenshot.png",
      mimeType: "image/png",
      kind: "image",
    });
    const planStore = new FakeCeoPlanStore(
      new Map([[CHILD_TASK_ID, { planId: PLAN_ID, parentTaskId: PARENT_TASK_ID }]]),
    );
    const materializer = new HallTaskAttachmentMaterializer({
      boardStore: new FakeBoardStore(new Set([PARENT_BOARD_ID])),
      messageStore: new FakeMessageStore([
        message({ boardId: PARENT_BOARD_ID, attachments: [parentAttachment] }),
      ]),
      blobStore,
      getCeoPlanStore: () => planStore,
    });

    expect(materializer.snapshotAttachments(CHILD_TASK_ID).attachments).toEqual([parentAttachment]);
  });

  it("combines the child's own board attachments with its inherited parent attachments", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const ownAttachment = attachment({
      attachmentId: "22222222-2222-4222-8222-222222222222",
      filename: "own.txt",
    });
    const parentAttachment = attachment({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "screenshot.png",
      mimeType: "image/png",
      kind: "image",
    });
    const planStore = new FakeCeoPlanStore(
      new Map([[CHILD_TASK_ID, { planId: PLAN_ID, parentTaskId: PARENT_TASK_ID }]]),
    );
    const materializer = new HallTaskAttachmentMaterializer({
      boardStore: new FakeBoardStore(new Set([CHILD_BOARD_ID, PARENT_BOARD_ID])),
      messageStore: new FakeMessageStore([
        message({ boardId: CHILD_BOARD_ID, attachments: [ownAttachment] }),
        message({ boardId: PARENT_BOARD_ID, attachments: [parentAttachment] }),
      ]),
      blobStore,
      getCeoPlanStore: () => planStore,
    });

    const snapshot = materializer.snapshotAttachments(CHILD_TASK_ID).attachments;
    expect(snapshot).toHaveLength(2);
    expect(snapshot).toEqual(expect.arrayContaining([ownAttachment, parentAttachment]));
  });

  it("deduplicates by attachmentId when the same attachment id appears on both the child's own board and the inherited parent board", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const shared = attachment({ attachmentId: "11111111-1111-4111-8111-111111111111" });
    const planStore = new FakeCeoPlanStore(
      new Map([[CHILD_TASK_ID, { planId: PLAN_ID, parentTaskId: PARENT_TASK_ID }]]),
    );
    const materializer = new HallTaskAttachmentMaterializer({
      boardStore: new FakeBoardStore(new Set([CHILD_BOARD_ID, PARENT_BOARD_ID])),
      messageStore: new FakeMessageStore([
        message({ boardId: CHILD_BOARD_ID, attachments: [shared] }),
        message({ boardId: PARENT_BOARD_ID, attachments: [shared] }),
      ]),
      blobStore,
      getCeoPlanStore: () => planStore,
    });

    expect(materializer.snapshotAttachments(CHILD_TASK_ID).attachments).toEqual([shared]);
  });

  it("a task not linked to any CEO plan inherits nothing, even when a plan store is wired", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const planStore = new FakeCeoPlanStore(new Map()); // TASK_ID has no delegation link
    const materializer = buildMaterializer(
      [BOARD_ID],
      [message({ text: "just chatting" })],
      blobStore,
      {
        getCeoPlanStore: () => planStore,
      },
    );
    expect(materializer.snapshotAttachments(TASK_ID)).toEqual({ attachments: [] });
  });

  it("no getCeoPlanStore wired at all (default composition without CEO plans) behaves exactly as before — own board only", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const a = attachment();
    const materializer = buildMaterializer([BOARD_ID], [message({ attachments: [a] })], blobStore);
    expect(materializer.snapshotAttachments(TASK_ID).attachments).toEqual([a]);
  });

  it("the combined inherited + own snapshot is still bounded by the same materialization limits", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const ownMany = Array.from({ length: MAX_TASK_ATTACHMENTS }, (_, index) =>
      attachment({
        attachmentId: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
        filename: `own-${String(index)}.txt`,
      }),
    );
    const inheritedOne = attachment({
      attachmentId: "99999999-1111-4111-8111-111111111111",
      filename: "inherited.png",
      mimeType: "image/png",
      kind: "image",
    });
    const planStore = new FakeCeoPlanStore(
      new Map([[CHILD_TASK_ID, { planId: PLAN_ID, parentTaskId: PARENT_TASK_ID }]]),
    );
    const materializer = new HallTaskAttachmentMaterializer({
      boardStore: new FakeBoardStore(new Set([CHILD_BOARD_ID, PARENT_BOARD_ID])),
      messageStore: new FakeMessageStore([
        message({ boardId: CHILD_BOARD_ID, attachments: ownMany }),
        message({ boardId: PARENT_BOARD_ID, attachments: [inheritedOne] }),
      ]),
      blobStore,
      getCeoPlanStore: () => planStore,
    });
    const workingDirectory = makeTempDir();
    const snapshot = materializer.snapshotAttachments(CHILD_TASK_ID);
    expect(snapshot.attachments).toHaveLength(MAX_TASK_ATTACHMENTS + 1);

    expect(() => materializer.materializeSnapshot(snapshot, workingDirectory)).toThrow(
      AttachmentMaterializationLimitExceededError,
    );
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
      {
        relativePath: expectedRelativePath,
        filename: "notes.txt",
        mimeType: "text/plain",
        kind: "file",
      },
    ]);
    expect(fs.readFileSync(path.join(workingDirectory, expectedRelativePath), "utf8")).toBe(
      "hello world",
    );
  });

  it("materializes multiple attachments independently", () => {
    const blobStore = new AttachmentBlobStore({ rootDir: makeTempDir() });
    const a = attachment({
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "a.txt",
    });
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

    expect(() =>
      materializer.materializeSnapshot({ attachments: [huge] }, workingDirectory),
    ).toThrow(AttachmentMaterializationLimitExceededError);
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
