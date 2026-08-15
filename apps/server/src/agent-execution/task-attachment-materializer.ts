import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MessageAttachment } from "@hall-of-wisdom/protocol";
import {
  MAX_TASK_ATTACHMENTS,
  MAX_TASK_ATTACHMENTS_TOTAL_BYTES,
  type TaskAttachmentManifestEntry,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { AttachmentBlobStore } from "../boards/attachment-blob-store.js";
import type { BoardStorePort } from "../boards/board-store-port.js";
import { taskBoardId } from "../boards/board-store.js";
import type { MessageStorePort } from "../boards/message-store-port.js";
import {
  AttachmentBlobUnavailableError,
  AttachmentMaterializationLimitExceededError,
} from "./agent-execution-errors.js";

/**
 * Hall-owned, bounded subdirectory materialized attachments live under,
 * relative to an agent's isolated working directory. `GitArtifactCollector`
 * excludes this exact directory from its collected diff — everything under
 * it is Hall-injected input, never agent-produced output — and no separate
 * cleanup is needed: it lives inside the worktree, so removing the worktree
 * removes it.
 */
export const HALL_ATTACHMENTS_DIRNAME = ".hall-attachments";

/**
 * A point-in-time read of which attachments currently apply to a task,
 * cheap enough (board/message metadata only, no blob bytes) to take before
 * deciding whether isolation is even available.
 */
export interface TaskAttachmentSnapshot {
  readonly attachments: readonly MessageAttachment[];
}

export interface TaskAttachmentMaterializer {
  snapshotAttachments(taskId: string): TaskAttachmentSnapshot;
  materializeSnapshot(
    snapshot: TaskAttachmentSnapshot,
    agentWorkingDirectory: string,
  ): TaskAttachmentManifestEntry[];
}

export interface HallTaskAttachmentMaterializerOptions {
  readonly boardStore: BoardStorePort;
  readonly messageStore: MessageStorePort;
  readonly blobStore: AttachmentBlobStore;
}

/**
 * The one implementation of the attachment bridge: at each execution
 * attempt, snapshots every attachment linked to a *human*-authored message
 * on the task's own Communication Board (`task:<taskId>`, deterministic —
 * see `taskBoardId`), then, once an isolated worktree exists, copies the
 * underlying bytes into it. System-authored messages (CEO audit posts,
 * execution-status posts) never carry attachments today, but the human-only
 * filter is explicit here rather than incidental. A task with no board, or
 * a board with no human attachments, snapshots to an empty list — this is
 * what keeps a text-only task's execution byte-identical to before this
 * class existed.
 */
export class HallTaskAttachmentMaterializer implements TaskAttachmentMaterializer {
  readonly #boardStore: BoardStorePort;
  readonly #messageStore: MessageStorePort;
  readonly #blobStore: AttachmentBlobStore;

  constructor(options: HallTaskAttachmentMaterializerOptions) {
    this.#boardStore = options.boardStore;
    this.#messageStore = options.messageStore;
    this.#blobStore = options.blobStore;
  }

  snapshotAttachments(taskId: string): TaskAttachmentSnapshot {
    const boardId = taskBoardId(taskId);
    if (!this.#boardStore.has(boardId)) return { attachments: [] };
    const attachments = this.#messageStore
      .list(boardId)
      .filter((message) => message.author.kind === "human")
      .flatMap((message) => message.attachments ?? []);
    return { attachments };
  }

  materializeSnapshot(
    snapshot: TaskAttachmentSnapshot,
    agentWorkingDirectory: string,
  ): TaskAttachmentManifestEntry[] {
    const { attachments } = snapshot;
    if (attachments.length === 0) return [];

    const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.byteSize, 0);
    if (attachments.length > MAX_TASK_ATTACHMENTS || totalBytes > MAX_TASK_ATTACHMENTS_TOTAL_BYTES) {
      throw new AttachmentMaterializationLimitExceededError();
    }

    mkdirSync(path.join(agentWorkingDirectory, HALL_ATTACHMENTS_DIRNAME), { recursive: true });
    return attachments.map((attachment) =>
      this.#materializeOne(attachment, agentWorkingDirectory),
    );
  }

  #materializeOne(
    attachment: MessageAttachment,
    agentWorkingDirectory: string,
  ): TaskAttachmentManifestEntry {
    let bytes: Buffer;
    try {
      bytes = this.#blobStore.read(attachment.attachmentId);
    } catch {
      throw new AttachmentBlobUnavailableError();
    }
    // Both segments are already validated safe (a server-generated UUID,
    // and a filename rejected at upload time for control characters, path
    // separators, and quotes) — this is a display path, always
    // forward-slash, never built from `path.join` (which would emit `\`
    // on Windows and leak into the manifest an adapter reads verbatim).
    const relativeDir = `${HALL_ATTACHMENTS_DIRNAME}/${attachment.attachmentId}`;
    mkdirSync(path.join(agentWorkingDirectory, relativeDir), { recursive: true });
    const relativePath = `${relativeDir}/${attachment.filename}`;
    writeFileSync(path.join(agentWorkingDirectory, relativePath), bytes);
    return {
      relativePath,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
    };
  }
}
