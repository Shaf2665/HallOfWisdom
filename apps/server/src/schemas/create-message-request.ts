import { z } from "zod";
import { communicationMessageTextSchema } from "@hall-of-wisdom/protocol";

/**
 * `.strict()` with exactly one field is what makes "the browser cannot
 * select or spoof the author" true by construction: there is no `author`
 * key in this schema's shape at all, so a request body carrying one is
 * rejected outright before the route ever has a chance to (correctly or
 * incorrectly) ignore it.
 */
export const createMessageRequestSchema = z
  .object({
    text: communicationMessageTextSchema,
  })
  .strict();
export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;
