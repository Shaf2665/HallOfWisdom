import { z } from "zod";
import { boundedNonBlankString, isoTimestampSchema, nonEmptyIdSchema } from "./ids.js";
import { parseWithSchema } from "./errors.js";

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
 * Blank-after-trim is rejected, but the original text (including internal
 * line breaks) is preserved on success — trimming is only used to decide
 * validity, never applied to the stored/returned value. NUL characters are
 * rejected outright: they have no legitimate place in a plain-text chat
 * message and can cause inconsistent handling across terminals, browsers,
 * and future storage layers.
 */
export const communicationMessageTextSchema = z
  .string()
  .max(
    MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH,
    `text must not exceed ${String(MAX_COMMUNICATION_MESSAGE_TEXT_LENGTH)} characters`,
  )
  .refine((value) => value.trim().length > 0, "text must not be blank")
  .refine((value) => !value.includes(NUL_CHARACTER), "text must not contain NUL characters");

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
    createdAt: isoTimestampSchema,
  })
  .strict();
export type CommunicationMessage = z.infer<typeof communicationMessageSchema>;

export function parseCommunicationMessage(input: unknown): CommunicationMessage {
  return parseWithSchema(communicationMessageSchema, input, "CommunicationMessage");
}
