import { z } from "zod";
import { boundedNonBlankString, isoTimestampSchema, nonEmptyIdSchema } from "./ids.js";
import { parseWithSchema } from "./errors.js";

export const communicationBoardKindSchema = z.enum(["general", "task"]);
export type CommunicationBoardKind = z.infer<typeof communicationBoardKindSchema>;

/**
 * Phase 8 supports exactly one author shape: a human operator typing
 * locally. `kind` is a literal (not a free-form string) so a future
 * agent-authored message type can be added as a new union member later
 * without silently being accepted as `"human"` today. The browser never
 * supplies this — Hall Core always constructs it server-side (see
 * `docs/architecture/0007-communication-boards.md`, "Server-owned author").
 */
export const communicationAuthorSchema = z
  .object({
    kind: z.literal("human"),
    displayName: boundedNonBlankString(100),
  })
  .strict();
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
