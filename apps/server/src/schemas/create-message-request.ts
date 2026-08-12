import { z } from "zod";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  communicationMessageTextSchema,
  hasTextOrAttachments,
  nonEmptyIdSchema,
} from "@hall-of-wisdom/protocol";

/**
 * `.strict()` with exactly `text`/`attachmentIds` is what makes "the
 * browser cannot select or spoof the author" true by construction: there is
 * no `author` key in this schema's shape at all, so a request body carrying
 * one is rejected outright before the route ever has a chance to (correctly
 * or incorrectly) ignore it. `attachmentIds` carries only ids of attachments
 * the client already uploaded via `POST .../attachments` — never filename/
 * mime/size, so the route always resolves canonical metadata from Hall
 * Core's own attachment store rather than trusting anything the client
 * claims about an attachment at message-creation time. `text` alone may now
 * be blank (see `communicationMessageTextSchema`'s doc comment) — this
 * schema's own `.superRefine()` is what still requires the message to have
 * *something*, text or at least one attachment.
 */
export const createMessageRequestSchema = z
  .object({
    text: communicationMessageTextSchema,
    attachmentIds: z.array(nonEmptyIdSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!hasTextOrAttachments({ text: value.text, attachments: value.attachmentIds })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "text must not be blank unless the message has at least one attachment",
      });
    }
  });
export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;
