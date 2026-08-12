import { z } from "zod";
import { boundedNonBlankString, isoTimestampSchema, nonEmptyIdSchema } from "./ids.js";
import { parseWithSchema } from "./errors.js";
import { MAX_ATTACHMENTS_PER_MESSAGE, messageAttachmentSchema } from "./attachment.js";

export const communicationBoardKindSchema = z.enum(["general", "task"]);
export type CommunicationBoardKind = z.infer<typeof communicationBoardKindSchema>;

/**
 * Phase 8 shipped with exactly one author shape (`"human"`) and a doc
 * comment anticipating this: "`kind` is a literal ... so a future
 * agent-authored message type can be added as a new union member later
 * without silently being accepted as `"human"` today." Phase 14 is that
 * addition — the CEO Agent posts bounded audit summaries (plan created,
 * submitted, approved, rejected, delegated, completed/failed) to a task's
 * board, and those messages must never be mistaken for something a human
 * operator typed. `"system"` is deliberately generic (not `"ceo_agent"`)
 * so any future non-human, non-adapter-run message source can reuse it
 * rather than the union growing one literal per feature. The browser
 * never supplies either kind — Hall Core always constructs the author
 * server-side (see `docs/architecture/0007-communication-boards.md`,
 * "Server-owned author").
 */
export const communicationAuthorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("human"),
      displayName: boundedNonBlankString(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("system"),
      displayName: boundedNonBlankString(100),
    })
    .strict(),
]);
export type CommunicationAuthor = z.infer<typeof communicationAuthorSchema>;

const communicationBoardSharedFields = {
  boardId: nonEmptyIdSchema,
  title: boundedNonBlankString(200),
  description: z.string().max(2000, "description must not exceed 2000 characters").optional(),
  projectId: nonEmptyIdSchema.optional(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  messageCount: z.number().int().nonnegative(),
};

const generalCommunicationBoardSchema = z
  .object({
    ...communicationBoardSharedFields,
    kind: z.literal("general"),
  })
  .strict();

/**
 * `taskId` is part of this branch's shape, not merely optional on a shared
 * object — `z.discriminatedUnion` on `kind` is what makes "general must not
 * require taskId" and "task must require taskId" both true at the type
 * level, the same pattern `create-task-request.ts` already uses for
 * immediate-vs-deferred task creation.
 */
const taskCommunicationBoardSchema = z
  .object({
    ...communicationBoardSharedFields,
    kind: z.literal("task"),
    taskId: nonEmptyIdSchema,
  })
  .strict();

export const communicationBoardSchema = z.discriminatedUnion("kind", [
  generalCommunicationBoardSchema,
  taskCommunicationBoardSchema,
]);
export type CommunicationBoard = z.infer<typeof communicationBoardSchema>;

export function parseCommunicationBoard(input: unknown): CommunicationBoard {
  return parseWithSchema(communicationBoardSchema, input, "CommunicationBoard");
}

/** The absolute ceiling on message text length — the single authoritative check; server-side stores must never enforce a *larger* limit than this. */
export const MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH = 4000;

const NUL_CHARACTER = String.fromCharCode(0);

/**
 * The original text (including internal line breaks) is always preserved
 * exactly as given — this schema only bounds length and rejects NUL
 * characters (they have no legitimate place in a plain-text chat message
 * and can cause inconsistent handling across terminals, browsers, and
 * future storage layers). Blank text is allowed at this field's level: a
 * message may be attachments-only (see `messageAttachmentSchema`), so
 * "must have text or attachments" is enforced as a cross-field check on
 * `communicationMessageSchema` (and, server-side, on the create-message
 * request schema) rather than here.
 */
export const communicationMessageTextSchema = z
  .string()
  .max(
    MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH,
    `text must not exceed ${String(MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH)} characters`,
  )
  .refine((value) => !value.includes(NUL_CHARACTER), "text must not contain NUL characters");

/** Shared by `communicationMessageSchema` and the server's create-message request schema. */
export function hasTextOrAttachments(value: {
  readonly text: string;
  readonly attachments?: readonly unknown[] | undefined;
}): boolean {
  return value.text.trim().length > 0 || (value.attachments?.length ?? 0) > 0;
}

/**
 * Server-owned navigation attached to a Hall-generated message. The
 * browser's human-message endpoint accepts text only, so a user-authored
 * message can never supply this reference.
 */
export const communicationMessageReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ceo_plan_created"),
      planId: nonEmptyIdSchema,
      stepCount: z.number().int().nonnegative().max(20),
    })
    .strict(),
]);
export type CommunicationMessageReference = z.infer<
  typeof communicationMessageReferenceSchema
>;

/**
 * Communication-message `sequence` is a wholly independent counter from a
 * `NormalizedAgentEvent`'s `sequence` — same *shape* (non-negative integer,
 * starts at zero, strictly increasing per board), but a different
 * namespace entirely (per-board here, per-task-run there). A communication
 * message is never encoded as a `NormalizedAgentEvent`: the two protocols
 * model different things (human discussion vs. agent execution progress)
 * and must not be conflated even though both happen to stream over
 * WebSocket.
 */
export const communicationMessageSchema = z
  .object({
    messageId: nonEmptyIdSchema,
    boardId: nonEmptyIdSchema,
    sequence: z.number().int().nonnegative(),
    author: communicationAuthorSchema,
    text: communicationMessageTextSchema,
    /**
     * Omitted entirely (never an empty array) when the message has no
     * attachments — this is what keeps every existing text-only message
     * payload byte-identical to before this field existed. See
     * `docs/architecture/0020-communication-board-attachments.md`.
     */
    attachments: z.array(messageAttachmentSchema).min(1).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    reference: communicationMessageReferenceSchema.optional(),
    createdAt: isoTimestampSchema,
  })
  .strict()
  .refine(hasTextOrAttachments, {
    message: "text must not be blank unless the message has at least one attachment",
    path: ["text"],
  });
export type CommunicationMessage = z.infer<typeof communicationMessageSchema>;

export function parseCommunicationMessage(input: unknown): CommunicationMessage {
  return parseWithSchema(communicationMessageSchema, input, "CommunicationMessage");
}
