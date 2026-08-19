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
import type { CeoPlanStorePort } from "../ceo-plans/ceo-plan-store-port.js";
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
  /**
   * Lazily resolves the CEO plan store, for inheriting a delegated child
   * task's parent Gateway attachments (Issue #23) — a thunk, not the store
   * itself, because at composition time the plan store does not exist yet
   * when this materializer is constructed (see `mock-agent-composition-root.ts`'s
   * `ceoOrchestratorRef`-style forward reference). `undefined`, or a thunk
   * that itself resolves to `undefined`, means "no CEO plan store wired" —
   * every task then snapshots exactly as it always has: its own board only.
   */
  readonly getCeoPlanStore?: (() => CeoPlanStorePort | undefined) | undefined;
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
 *
 * A CEO-delegated child task additionally inherits its CEO plan's parent
 * Gateway task's own human attachments (Issue #23), deduplicated by
 * `attachmentId` against the child's own — found via
 * `CeoPlanStorePort.findPlanIdByChildTaskId`, never by re-deriving the
 * relationship from anywhere else. Nothing is copied into another board or
 * blob store; only the snapshot (metadata) is merged, and the underlying
 * blob is still read once, lazily, at materialize time.
 */
export class HallTaskAttachmentMaterializer implements TaskAttachmentMaterializer {
  readonly #boardStore: BoardStorePort;
  readonly #messageStore: MessageStorePort;
  readonly #blobStore: AttachmentBlobStore;
  readonly #getCeoPlanStore: (() => CeoPlanStorePort | undefined) | undefined;

  constructor(options: HallTaskAttachmentMaterializerOptions) {
    this.#boardStore = options.boardStore;
    this.#messageStore = options.messageStore;
    this.#blobStore = options.blobStore;
    this.#getCeoPlanStore = options.getCeoPlanStore;
  }

  snapshotAttachments(taskId: string): TaskAttachmentSnapshot {
    const ownAttachments = this.#snapshotBoardAttachments(taskId);
    const inheritedAttachments = this.#snapshotInheritedAttachments(taskId);
    if (inheritedAttachments.length === 0) return { attachments: ownAttachments };

    const seenAttachmentIds = new Set(ownAttachments.map((attachment) => attachment.attachmentId));
    const merged = [...ownAttachments];
    for (const attachment of inheritedAttachments) {
      if (seenAttachmentIds.has(attachment.attachmentId)) continue;
      seenAttachmentIds.add(attachment.attachmentId);
      merged.push(attachment);
    }
    return { attachments: merged };
  }

  #snapshotBoardAttachments(taskId: string): MessageAttachment[] {
    const boardId = taskBoardId(taskId);
    if (!this.#boardStore.has(boardId)) return [];
    return this.#messageStore
      .list(boardId)
      .filter((message) => message.author.kind === "human")
      .flatMap((message) => message.attachments ?? []);
  }

  #snapshotInheritedAttachments(taskId: string): MessageAttachment[] {
    const planStore = this.#getCeoPlanStore?.();
    if (planStore === undefined) return [];
    const planId = planStore.findPlanIdByChildTaskId(taskId);
    if (planId === undefined) return [];
    const parentTaskId = planStore.getPlan(planId).parentTaskId;
    return this.#snapshotBoardAttachments(parentTaskId);
  }

  materializeSnapshot(
    snapshot: TaskAttachmentSnapshot,
    agentWorkingDirectory: string,
  ): TaskAttachmentManifestEntry[] {
    const { attachments } = snapshot;
    if (attachments.length === 0) return [];

    const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.byteSize, 0);
    if (
      attachments.length > MAX_TASK_ATTACHMENTS ||
      totalBytes > MAX_TASK_ATTACHMENTS_TOTAL_BYTES
    ) {
      throw new AttachmentMaterializationLimitExceededError();
    }

    mkdirSync(path.join(agentWorkingDirectory, HALL_ATTACHMENTS_DIRNAME), { recursive: true });
    return attachments.map((attachment) => this.#materializeOne(attachment, agentWorkingDirectory));
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
