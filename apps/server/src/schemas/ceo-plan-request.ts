import { z } from "zod";
import {
  boundedNonBlankString,
  capabilityIdSchema,
  ceoPlanContentHashSchema,
  ceoPlanningInstructionsSchema,
  executionTrustSchema,
  nonEmptyIdSchema,
  MAX_ACCEPTANCE_CRITERIA_PER_STEP,
  MAX_ACCEPTANCE_CRITERION_LENGTH,
  MAX_ASSUMPTION_OR_CONSTRAINT_LENGTH,
  MAX_CEO_PLAN_STEPS,
  MAX_DEPENDENCIES_PER_STEP,
  MAX_PLAN_ASSUMPTIONS_OR_CONSTRAINTS,
  MAX_PLAN_OBJECTIVE_LENGTH,
  MAX_PLAN_SUMMARY_LENGTH,
  MAX_STEP_TEXT_LENGTH,
  MAX_STEP_TITLE_LENGTH,
} from "@hall-of-wisdom/protocol";
import { MUTATION_TOKEN_PATTERN } from "../ceo-plans/ceo-plan-mutation-token.js";

/** Phase 14.1 — every mutating CEO-plan route requires this in place of the old plain-integer `expectedRevision`. A malformed token (wrong length/alphabet) fails this schema (400) before ever reaching the orchestrator; a well-formed but stale/wrong token fails inside the orchestrator (409, `CeoPlanMutationTokenInvalidError`). See `ceo-plan-mutation-token.ts`. */
const expectedMutationTokenSchema = z.string().regex(MUTATION_TOKEN_PATTERN);

/** `POST /api/v1/tasks/:taskId/ceo-plans` — the only browser-controlled input to plan generation is this one bounded, optional field. Never a step, a requirement, an adapter id, or anything else the deterministic planner itself must derive. */
export const createCeoPlanRequestSchema = z
  .object({
    planningInstructions: ceoPlanningInstructionsSchema,
  })
  .strict();
export type CreateCeoPlanRequest = z.infer<typeof createCeoPlanRequestSchema>;

const editedStepRequirementsSchema = z
  .object({
    requiredCapabilities: z.array(capabilityIdSchema).max(8),
    allowedExecutionTrust: z.array(executionTrustSchema).min(1).max(4),
  })
  .strict();

/**
 * `POST /api/v1/ceo-plans/:planId/versions` — the full edited plan
 * content the operator wants to persist as a new version. `selectedAdapterId`
 * is the one browser-controlled override this schema accepts; the route
 * never accepts a `recommendedAdapterId`, `routingSummary`,
 * `delegatedTaskId`, or content hash directly from the request — every
 * one of those is always server-computed (kickoff, "Adapter overrides":
 * "Do not allow a browser request to force an ineligible adapter" — the
 * eligibility check happens in `CeoPlanOrchestrator.delegate()`, not
 * here; this schema only bounds *shape*).
 */
export const editedCeoPlanStepRequestSchema = z
  .object({
    id: nonEmptyIdSchema,
    position: z.number().int().nonnegative(),
    title: boundedNonBlankString(MAX_STEP_TITLE_LENGTH),
    objective: boundedNonBlankString(MAX_STEP_TEXT_LENGTH),
    boundedInstructions: boundedNonBlankString(MAX_STEP_TEXT_LENGTH),
    acceptanceCriteria: z
      .array(boundedNonBlankString(MAX_ACCEPTANCE_CRITERION_LENGTH))
      .max(MAX_ACCEPTANCE_CRITERIA_PER_STEP),
    dependencies: z.array(nonEmptyIdSchema).max(MAX_DEPENDENCIES_PER_STEP),
    requirements: editedStepRequirementsSchema.optional(),
    selectedAdapterId: nonEmptyIdSchema.optional(),
  })
  .strict();

export const createCeoPlanVersionRequestSchema = z
  .object({
    expectedMutationToken: expectedMutationTokenSchema,
    objective: boundedNonBlankString(MAX_PLAN_OBJECTIVE_LENGTH),
    summary: boundedNonBlankString(MAX_PLAN_SUMMARY_LENGTH),
    assumptions: z
      .array(boundedNonBlankString(MAX_ASSUMPTION_OR_CONSTRAINT_LENGTH))
      .max(MAX_PLAN_ASSUMPTIONS_OR_CONSTRAINTS),
    constraints: z
      .array(boundedNonBlankString(MAX_ASSUMPTION_OR_CONSTRAINT_LENGTH))
      .max(MAX_PLAN_ASSUMPTIONS_OR_CONSTRAINTS),
    steps: z.array(editedCeoPlanStepRequestSchema).max(MAX_CEO_PLAN_STEPS),
  })
  .strict();
export type CreateCeoPlanVersionRequest = z.infer<typeof createCeoPlanVersionRequestSchema>;

/** `POST /api/v1/ceo-plans/:planId/submit` and `.../cancel` and `.../delegate` — every one of these needs only the caller's snapshotted mutation token (optimistic concurrency, kickoff: "Stale edit requests must return HTTP 409"). */
export const mutationTokenRequestSchema = z
  .object({
    expectedMutationToken: expectedMutationTokenSchema,
  })
  .strict();
export type MutationTokenRequest = z.infer<typeof mutationTokenRequestSchema>;

/**
 * `POST /api/v1/ceo-plans/:planId/approve` and `.../reject` — the
 * endpoint itself is the decision (kickoff: "Do not combine Approve and
 * Delegate into one button" — by the same logic, Approve and Reject stay
 * two distinct routes, never one "decide" endpoint with a body field
 * selecting which). Bound to the exact version and content hash the
 * operator saw (kickoff, "Plan versioning," item 5). `contentHash` here
 * is never treated as authoritative on its own (kickoff, item 9) —
 * `CeoPlanStorePort.decideApproval` always re-checks it against the
 * server's own stored hash for that version and rejects on any mismatch.
 */
export const decideCeoPlanApprovalRequestSchema = z
  .object({
    expectedMutationToken: expectedMutationTokenSchema,
    planVersion: z.number().int().positive(),
    contentHash: ceoPlanContentHashSchema,
    operatorNote: boundedNonBlankString(1000).optional(),
  })
  .strict();
export type DecideCeoPlanApprovalRequest = z.infer<typeof decideCeoPlanApprovalRequestSchema>;
