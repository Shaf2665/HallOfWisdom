import { z } from "zod";
import { ceoPlanExecutionModeSchema, ceoPlanExecutionPolicySchema } from "@hall-of-wisdom/protocol";
import { MUTATION_TOKEN_PATTERN } from "../ceo-plans/ceo-plan-mutation-token.js";

/**
 * Same pattern `ceo-plan-request.ts` uses for plan-level mutations, reused
 * here for plan-RUN-level mutations — a single generic
 * `createCeoPlanMutationTokenIssuer()` instance, keyed by `runId` instead
 * of `planId` and by the run's own `activeGeneration` instead of a plan
 * revision (see `routes/ceo-plan-runs.ts`'s own doc comment on why
 * `activeGeneration` is the chosen "revision" for this token).
 */
const expectedMutationTokenSchema = z.string().regex(MUTATION_TOKEN_PATTERN);

/**
 * `POST /api/v1/ceo-plans/:planId/execution/configure` — the only
 * browser-controlled inputs to configuring an execution run: which mode
 * (manual stays the default the operator must explicitly move off of —
 * this field is required, never defaulted server-side to "autonomous"),
 * and the bounded, already-strict policy snapshot
 * (`ceoPlanExecutionPolicySchema`, reused as-is — every numeric field is
 * already bounded there, so this schema adds no extra bounds of its own).
 * The plan id, delegated version, step ids, child task ids, and
 * dependency graph are never accepted from the browser — the route always
 * derives them itself from the plan's own delegation links and approved
 * version.
 */
export const configureCeoPlanRunRequestSchema = z
  .object({
    executionMode: ceoPlanExecutionModeSchema,
    policy: ceoPlanExecutionPolicySchema,
  })
  .strict();
export type ConfigureCeoPlanRunRequest = z.infer<typeof configureCeoPlanRunRequestSchema>;

/** Every plan-run lifecycle route below (start/pause/resume/cancel/emergency-stop) needs only the caller's snapshotted mutation token — same optimistic-concurrency discipline as `mutationTokenRequestSchema` in `ceo-plan-request.ts`. */
export const runMutationTokenRequestSchema = z
  .object({
    expectedMutationToken: expectedMutationTokenSchema,
  })
  .strict();
export type RunMutationTokenRequest = z.infer<typeof runMutationTokenRequestSchema>;
