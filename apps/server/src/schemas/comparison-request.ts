import { z } from "zod";
import { boundedNonBlankString, nonEmptyIdSchema } from "@hall-of-wisdom/protocol";

export const createComparisonRequestSchema = z
  .object({
    sourceTaskId: nonEmptyIdSchema,
    /** Exactly two distinct adapters — see `docs/architecture/0012-controlled-agent-comparison.md`, "Initial supported comparison." */
    candidateAdapterIds: z
      .tuple([nonEmptyIdSchema, nonEmptyIdSchema])
      .refine((ids) => ids[0] !== ids[1], "the two candidate adapters must be different"),
  })
  .strict();
export type CreateComparisonRequest = z.infer<typeof createComparisonRequestSchema>;

/** `candidateId: null` clears any previously recorded preference. */
export const setComparisonPreferenceRequestSchema = z
  .object({
    candidateId: nonEmptyIdSchema.nullable(),
    note: boundedNonBlankString(500).optional(),
  })
  .strict();
export type SetComparisonPreferenceRequest = z.infer<typeof setComparisonPreferenceRequestSchema>;
