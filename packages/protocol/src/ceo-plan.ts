import { z } from "zod";
import { boundedNonBlankString, isoTimestampSchema, nonEmptyIdSchema } from "./ids.js";
import { parseWithSchema } from "./errors.js";
import { taskRequirementsSchema } from "./capability.js";

/**
 * Phase 14 — the CEO Agent control plane. This module is deliberately
 * environment-agnostic (no Node built-ins, no `crypto`) so it can be
 * imported by Hall Web exactly like every other protocol schema — the
 * actual content-hash *computation* (SHA-256 over the canonical string
 * this module produces) lives server-side in
 * `apps/server/src/ceo-plans/ceo-plan-content-hash.ts`, which is the only
 * place allowed to import `node:crypto` for this purpose.
 */

export const MAX_CEO_PLAN_STEPS = 20;
export const MAX_STEP_TITLE_LENGTH = 200;
export const MAX_STEP_TEXT_LENGTH = 2000;
export const MAX_ACCEPTANCE_CRITERIA_PER_STEP = 20;
export const MAX_ACCEPTANCE_CRITERION_LENGTH = 500;
export const MAX_DEPENDENCIES_PER_STEP = 20;
export const MAX_PLAN_OBJECTIVE_LENGTH = 2000;
export const MAX_PLAN_SUMMARY_LENGTH = 4000;
export const MAX_PLAN_ASSUMPTIONS_OR_CONSTRAINTS = 20;
export const MAX_ASSUMPTION_OR_CONSTRAINT_LENGTH = 500;
export const MAX_ROUTING_SUMMARY_LENGTH = 1000;
export const MAX_OPERATOR_NOTE_LENGTH = 1000;
export const MAX_PLANNING_INSTRUCTIONS_LENGTH = 2000;

export const ceoPlanStatusSchema = z.enum([
  "draft",
  "awaiting_approval",
  "approved",
  "rejected",
  "delegated",
  "completed",
  "failed",
  "cancelled",
]);
export type CeoPlanStatus = z.infer<typeof ceoPlanStatusSchema>;

/** Who authored a plan version or a decision — never "an agent" for an approval; see `ceoApprovalSchema`. */
export const ceoPlanActorSchema = z.enum(["ceo_planner", "operator"]);
export type CeoPlanActor = z.infer<typeof ceoPlanActorSchema>;

export const ceoApprovalDecisionSchema = z.enum(["approve", "reject"]);
export type CeoApprovalDecision = z.infer<typeof ceoApprovalDecisionSchema>;

/** Hex-encoded SHA-256, always exactly 64 lowercase hex characters — never accepted as authoritative from a browser request; see `docs/architecture/0014-ceo-planning-approval-and-delegation.md`, "Content-hash approval binding." */
export const ceoPlanContentHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a 64-character lowercase hex SHA-256 digest");
export type CeoPlanContentHash = z.infer<typeof ceoPlanContentHashSchema>;

export const ceoPlanEventTypeSchema = z.enum([
  "ceo.plan.created",
  "ceo.plan.version_created",
  "ceo.plan.submitted",
  "ceo.plan.approved",
  "ceo.plan.rejected",
  "ceo.plan.cancelled",
  "ceo.plan.delegated",
  "ceo.plan.progress_changed",
  "ceo.plan.completed",
  "ceo.plan.failed",
]);
export type CeoPlanEventType = z.infer<typeof ceoPlanEventTypeSchema>;

/** Same bounded, flat, safe-to-transmit shape as `StructuredFailure.details` — never nested, never unbounded. */
const boundedEventPayloadSchema = z
  .record(
    z.string().max(100, "payload key must not exceed 100 characters"),
    z.union([
      z.string().max(1000, "payload value must not exceed 1000 characters"),
      z.number(),
      z.boolean(),
      z.null(),
    ]),
  )
  .refine((payload) => Object.keys(payload).length <= 25, "payload must not exceed 25 keys");

export const ceoPlanEventSchema = z
  .object({
    planId: nonEmptyIdSchema,
    sequence: z.number().int().nonnegative(),
    type: ceoPlanEventTypeSchema,
    payload: boundedEventPayloadSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();
export type CeoPlanEvent = z.infer<typeof ceoPlanEventSchema>;

const ceoPlanStepBaseSchema = z
  .object({
    id: nonEmptyIdSchema,
    position: z.number().int().nonnegative(),
    title: boundedNonBlankString(MAX_STEP_TITLE_LENGTH),
    objective: boundedNonBlankString(MAX_STEP_TEXT_LENGTH),
    boundedInstructions: boundedNonBlankString(MAX_STEP_TEXT_LENGTH),
    acceptanceCriteria: z
      .array(boundedNonBlankString(MAX_ACCEPTANCE_CRITERION_LENGTH))
      .max(
        MAX_ACCEPTANCE_CRITERIA_PER_STEP,
        `must not exceed ${String(MAX_ACCEPTANCE_CRITERIA_PER_STEP)} acceptance criteria`,
      ),
    dependencies: z
      .array(nonEmptyIdSchema)
      .max(
        MAX_DEPENDENCIES_PER_STEP,
        `must not exceed ${String(MAX_DEPENDENCIES_PER_STEP)} dependencies`,
      ),
    requirements: taskRequirementsSchema.optional(),
    recommendedAdapterId: nonEmptyIdSchema.optional(),
    selectedAdapterId: nonEmptyIdSchema.optional(),
    routingSummary: boundedNonBlankString(MAX_ROUTING_SUMMARY_LENGTH),
    delegatedTaskId: nonEmptyIdSchema.optional(),
  })
  .strict();

export type CeoPlanStep = z.infer<typeof ceoPlanStepBaseSchema>;

/**
 * Cross-step invariants — these can only be checked with the full step
 * array in hand, so they live on the version schema's `.superRefine`
 * rather than on the individual step schema. Covers every "strict plan
 * step validation" bullet from the Phase 14 kickoff except the
 * single-step bounds already enforced by `ceoPlanStepBaseSchema` above.
 */
function validateSteps(steps: readonly CeoPlanStep[], ctx: z.RefinementCtx): void {
  if (steps.length > MAX_CEO_PLAN_STEPS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `must not exceed ${String(MAX_CEO_PLAN_STEPS)} steps`,
      path: ["steps"],
    });
  }

  const idCounts = new Map<string, number>();
  const positionCounts = new Map<number, number>();
  for (const step of steps) {
    idCounts.set(step.id, (idCounts.get(step.id) ?? 0) + 1);
    positionCounts.set(step.position, (positionCounts.get(step.position) ?? 0) + 1);
  }
  const stepIds = new Set(idCounts.keys());

  steps.forEach((step, index) => {
    if ((idCounts.get(step.id) ?? 0) > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate step id "${step.id}"`,
        path: ["steps", index, "id"],
      });
    }
    if ((positionCounts.get(step.position) ?? 0) > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate step position ${String(step.position)}`,
        path: ["steps", index, "position"],
      });
    }

    const seenDependencies = new Set<string>();
    for (const [depIndex, dependencyId] of step.dependencies.entries()) {
      if (dependencyId === step.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a step must not depend on itself",
          path: ["steps", index, "dependencies", depIndex],
        });
      } else if (!stepIds.has(dependencyId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown dependency step id "${dependencyId}"`,
          path: ["steps", index, "dependencies", depIndex],
        });
      } else if (seenDependencies.has(dependencyId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate dependency "${dependencyId}"`,
          path: ["steps", index, "dependencies", depIndex],
        });
      }
      seenDependencies.add(dependencyId);
    }
  });

  const cycleStepId = findDependencyCycle(steps);
  if (cycleStepId !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `dependency cycle detected, reachable from step "${cycleStepId}"`,
      path: ["steps"],
    });
  }
}

/** Standard three-color DFS cycle detection over the dependency graph; returns the first step id found to participate in a cycle, or `undefined` if the graph is acyclic. Unknown dependency ids are ignored here — `validateSteps` already reports those as a separate issue. */
function findDependencyCycle(steps: readonly CeoPlanStep[]): string | undefined {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map<string, "visiting" | "done">();

  function visit(stepId: string): boolean {
    const status = state.get(stepId);
    if (status === "done") return false;
    if (status === "visiting") return true;
    state.set(stepId, "visiting");
    const step = byId.get(stepId);
    if (step) {
      for (const dependencyId of step.dependencies) {
        if (byId.has(dependencyId) && visit(dependencyId)) return true;
      }
    }
    state.set(stepId, "done");
    return false;
  }

  for (const step of steps) {
    if (visit(step.id)) return step.id;
  }
  return undefined;
}

export const ceoPlanStepSchema = ceoPlanStepBaseSchema;

export const ceoPlanVersionSchema = z
  .object({
    planId: nonEmptyIdSchema,
    version: z.number().int().positive(),
    objective: boundedNonBlankString(MAX_PLAN_OBJECTIVE_LENGTH),
    summary: boundedNonBlankString(MAX_PLAN_SUMMARY_LENGTH),
    assumptions: z
      .array(boundedNonBlankString(MAX_ASSUMPTION_OR_CONSTRAINT_LENGTH))
      .max(MAX_PLAN_ASSUMPTIONS_OR_CONSTRAINTS),
    constraints: z
      .array(boundedNonBlankString(MAX_ASSUMPTION_OR_CONSTRAINT_LENGTH))
      .max(MAX_PLAN_ASSUMPTIONS_OR_CONSTRAINTS),
    steps: z.array(ceoPlanStepSchema),
    createdAt: isoTimestampSchema,
    createdBy: ceoPlanActorSchema,
    // Deliberately absent: `internalRevision` — see this file's header
    // comment and the Phase 14 kickoff, "Do not expose internal revisions
    // publicly." The private, store-internal version row carries it;
    // this public schema never does.
    contentHash: ceoPlanContentHashSchema,
  })
  .strict()
  .superRefine((version, ctx) => {
    validateSteps(version.steps, ctx);
  });
export type CeoPlanVersion = z.infer<typeof ceoPlanVersionSchema>;

export function parseCeoPlanVersion(input: unknown): CeoPlanVersion {
  return parseWithSchema(ceoPlanVersionSchema, input, "CeoPlanVersion");
}

export const ceoPlanSchema = z
  .object({
    id: nonEmptyIdSchema,
    parentTaskId: nonEmptyIdSchema,
    status: ceoPlanStatusSchema,
    activeVersion: z.number().int().positive(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    createdBy: ceoPlanActorSchema,
    delegatedAt: isoTimestampSchema.optional(),
    completedAt: isoTimestampSchema.optional(),
  })
  .strict();
export type CeoPlan = z.infer<typeof ceoPlanSchema>;

export function parseCeoPlan(input: unknown): CeoPlan {
  return parseWithSchema(ceoPlanSchema, input, "CeoPlan");
}

export const ceoApprovalSchema = z
  .object({
    planId: nonEmptyIdSchema,
    planVersion: z.number().int().positive(),
    decision: ceoApprovalDecisionSchema,
    operatorNote: boundedNonBlankString(MAX_OPERATOR_NOTE_LENGTH).optional(),
    decidedAt: isoTimestampSchema,
    contentHash: ceoPlanContentHashSchema,
  })
  .strict();
export type CeoApproval = z.infer<typeof ceoApprovalSchema>;

export function parseCeoApproval(input: unknown): CeoApproval {
  return parseWithSchema(ceoApprovalSchema, input, "CeoApproval");
}

/** Bounded plain text an operator may optionally supply to guide the deterministic planner — never interpreted as instructions to fabricate information the planner cannot derive; see `deterministic-ceo-planner.ts`. */
export const ceoPlanningInstructionsSchema = boundedNonBlankString(
  MAX_PLANNING_INSTRUCTIONS_LENGTH,
).optional();

/**
 * The exact, server-canonicalized content a plan version's hash is
 * computed over. Deliberately excludes `createdAt`/`createdBy` (metadata
 * about the version, not its substance), `contentHash` itself, any
 * internal revision, and `delegatedTaskId` (not knowable until after
 * approval, so it cannot be part of what the operator approved).
 * Field order here is irrelevant to the hash — `canonicalCeoPlanContent`
 * re-sorts every object's keys before serializing — but is kept stable
 * for readability.
 */
export interface CeoPlanContentInput {
  readonly objective: string;
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly constraints: readonly string[];
  readonly steps: readonly {
    readonly id: string;
    readonly position: number;
    readonly title: string;
    readonly objective: string;
    readonly boundedInstructions: string;
    readonly acceptanceCriteria: readonly string[];
    readonly dependencies: readonly string[];
    readonly requirements?: z.infer<typeof taskRequirementsSchema>;
    readonly recommendedAdapterId?: string;
    readonly selectedAdapterId?: string;
    readonly routingSummary: string;
  }[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize(record[key]);
    }
    return result;
  }
  return value;
}

/**
 * The canonical, deterministic string a plan version's content hash is
 * computed over — every object key sorted recursively (so field
 * declaration order and JSON.stringify's usual insertion-order behavior
 * can never change the hash), no whitespace. Pure and side-effect-free:
 * the same logical content always produces the same string, across
 * processes and across restarts. See `apps/server/src/ceo-plans/
 * ceo-plan-content-hash.ts` for the SHA-256 step over this string.
 */
export function canonicalCeoPlanContent(input: CeoPlanContentInput): string {
  return JSON.stringify(canonicalize(input));
}
