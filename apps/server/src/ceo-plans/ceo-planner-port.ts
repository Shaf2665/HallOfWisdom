import type { HallTask, TaskRequirements } from "@hall-of-wisdom/protocol";
import type { RoutingCandidateInput } from "../routing/routing-policy.js";
import type { AttachmentSignal } from "./ceo-plan-routing.js";

/**
 * One step in a planner's draft output — deliberately index-based
 * dependencies (`dependsOnStepIndex`, 0-based positions into the same
 * draft's `steps` array), not step ids: a planner has no reason to invent
 * or track ids, and `ceo-plan-orchestrator.ts` is the one place that
 * assigns real, stable, persisted ids (`randomUUID()`) when turning a
 * draft into a real `CeoPlanVersion`, remapping indices to ids at that
 * point. This is the CEO plan analogue of `TaskStore.add()` taking a
 * fully-formed record — planners produce content, never identity.
 */
export interface CeoPlannerStepDraft {
  readonly title: string;
  readonly objective: string;
  readonly boundedInstructions: string;
  readonly acceptanceCriteria: readonly string[];
  readonly dependsOnStepIndex: readonly number[];
  readonly requirements?: TaskRequirements;
  readonly recommendedAdapterId?: string;
  readonly routingSummary: string;
}

export interface CeoPlannerPlanDraft {
  readonly objective: string;
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly constraints: readonly string[];
  readonly steps: readonly CeoPlannerStepDraft[];
}

/**
 * A planner's two possible outcomes — never a third "I'll guess" outcome.
 * `blocked` is what a planner returns when the parent task does not carry
 * enough real information to produce a plan without fabricating content
 * (Phase 14 kickoff, "Deterministic planner": "When task information is
 * insufficient: produce a plan requiring clarification; or return a
 * bounded planning-blocked result"). `reason` is bounded, safe plain text
 * — never raw model reasoning (there is no model in Phase 14), never a
 * path, never provider output.
 */
export type CeoPlannerResult =
  | { readonly kind: "plan"; readonly draft: CeoPlannerPlanDraft }
  | { readonly kind: "blocked"; readonly reason: string };

export interface CeoPlannerInput {
  readonly parentTask: HallTask;
  /** Already-detected candidates for this call — the planner itself never calls `adapter.detect()`; see `ceo-plan-orchestrator.ts`. */
  readonly routingCandidates: readonly RoutingCandidateInput[];
  readonly planningInstructions: string | undefined;
  /**
   * Issue #23 — what the parent task's own Communication Board carries:
   * no human attachment, a human attachment that isn't an image, or a
   * human image attachment. Metadata only (an attachment's `kind`, itself
   * always server-derived from MIME type — see `classifyAttachmentKind`),
   * never the attachment's bytes: the CEO planner remains deterministic
   * and never inspects image pixels. A planner uses this only to decide
   * whether a step's `requirements` should require isolated execution
   * and/or `vision.image` (`withAttachmentDerivedRequirements` in
   * `ceo-plan-routing.ts`) — it is not itself a capability or a routing
   * decision.
   */
  readonly attachmentSignal: AttachmentSignal;
}

/**
 * The one abstraction every CEO plan generation call goes through —
 * production Phase 14 wires `createDeterministicCeoPlanner()`
 * (`deterministic-ceo-planner.ts`); tests may substitute a scripted
 * planner satisfying this same interface. Nothing in
 * `ceo-plan-orchestrator.ts`, the routes, persistence, approval, or
 * delegation code depends on which concrete planner is wired — a future
 * model-backed planner can be added later purely by implementing this
 * interface, with zero change to approval/persistence/delegation
 * semantics (Phase 14 kickoff, "CEO Agent position in the architecture").
 * `generatePlan` is deliberately synchronous: it must never call an
 * adapter, start a task, or perform I/O of any kind — see this file's
 * other doc comments and `docs/architecture/0014-ceo-planning-approval-
 * and-delegation.md`, "CEO Agent is a control-plane planner, not an
 * executable adapter."
 */
export interface CeoPlannerPort {
  readonly plannerId: string;
  generatePlan(input: CeoPlannerInput): CeoPlannerResult;
}
