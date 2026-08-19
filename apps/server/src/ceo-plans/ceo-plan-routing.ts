import type { TaskRequirements } from "@hall-of-wisdom/protocol";
import type { RoutingCandidateInput } from "../routing/routing-policy.js";
import { evaluateRouting } from "../routing/routing-policy.js";

export interface CeoStepRoutingResult {
  readonly recommendedAdapterId: string | undefined;
  readonly routingSummary: string;
}

/**
 * The one place a CEO plan step's adapter recommendation is computed —
 * used at plan-generation time (by the deterministic planner) and again,
 * unchanged, at approval-time review and delegation-time revalidation
 * (`ceo-plan-orchestrator.ts`), so "planning-time recommendations are
 * advisory, delegation-time eligibility is authoritative" (Phase 14
 * kickoff) is true by construction: every caller runs the exact same
 * `evaluateRouting` policy `routing-analysis`/`route-and-assign`/manual
 * assignment already use, just against whatever candidate list and
 * requirements are current at that call site. Never a second,
 * independently-reimplemented capability-matching algorithm.
 *
 * A step with no `requirements` at all gets no recommendation — the
 * planner must not guess at capability/trust constraints the task itself
 * never stated (Phase 14 kickoff, "must not pretend to understand
 * information it cannot derive").
 */
export function recommendStepAdapter(
  requirements: TaskRequirements | undefined,
  candidates: readonly RoutingCandidateInput[],
): CeoStepRoutingResult {
  if (requirements === undefined) {
    return {
      recommendedAdapterId: undefined,
      routingSummary:
        "No capability or execution-trust requirements are set on the parent task, so no adapter can be safely recommended for this step.",
    };
  }
  const routing = evaluateRouting(requirements, candidates);
  return {
    recommendedAdapterId: routing.recommendedAdapterId,
    routingSummary: routing.explanation,
  };
}

/**
 * Summarizes what an attachment-inheriting step needs to know about its
 * parent's attachments — never the bytes, only the classification every
 * `MessageAttachment.kind` already carries (`classifyAttachmentKind`).
 * `"image"` is the strictly more-constrained case (isolation *and*
 * vision), so it takes precedence over `"file"` when a parent has both.
 */
export type AttachmentSignal = "none" | "file" | "image";

const ISOLATED_ONLY: TaskRequirements["allowedExecutionTrust"] = ["isolated"];

export type AttachmentRequirementsResult =
  | { readonly kind: "requirements"; readonly requirements: TaskRequirements | undefined }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Issue #23 (final correction) — `TaskAttachmentMaterializer` only ever
 * copies attachment bytes into an isolated worktree
 * (`AttachmentsRequireIsolatedExecutionError` otherwise: see
 * `docs/architecture/0020-communication-board-attachments.md`, "Isolation
 * is required"), so a non-isolated adapter was never actually a valid
 * candidate for attachment-bearing work — it would only fail later, at
 * execution time, with the entirely predictable
 * `ATTACHMENT_REQUIRES_ISOLATED_EXECUTION`. This function turns that fact
 * into a routing/delegation-time constraint: **any** inherited attachment
 * (image or not) narrows `allowedExecutionTrust` to its intersection with
 * `["isolated"]` — never widens it, so an operator's own, stricter trust
 * policy is always preserved — and an image attachment additionally
 * requires verified `vision.image`, exactly as before this correction
 * (see `TaskOrchestrator#requirementsWithVisionIfImageAttached` for the
 * equivalent direct-task rule this mirrors).
 *
 * If the parent task's own requirements already exclude `"isolated"`
 * entirely, this returns `"blocked"` rather than silently narrowing down
 * to an empty (and schema-invalid — `taskRequirementsSchema.allowedExecutionTrust`
 * requires at least one entry) trust list: "fail clearly," per the
 * correction's own requirement, not "fail as an opaque ineligibility."
 *
 * Synthesizes a fresh requirements object when `requirements` was
 * `undefined` — a CEO plan step always needs *some* adapter selected, so
 * it cannot opt out of capability-based eligibility filtering the way a
 * requirements-less direct task can. An already-present `vision.image` is
 * left as-is (idempotent), and a requirements object already at the
 * 9-capability cap is left unchanged — `TaskAttachmentMaterializer`'s
 * execution-time checks (isolation, then vision) remain the authoritative,
 * fail-closed backstop regardless.
 */
export function withAttachmentDerivedRequirements(
  requirements: TaskRequirements | undefined,
  attachmentSignal: AttachmentSignal,
): AttachmentRequirementsResult {
  if (attachmentSignal === "none") {
    return { kind: "requirements", requirements };
  }

  const allowedExecutionTrust =
    requirements === undefined
      ? [...ISOLATED_ONLY]
      : requirements.allowedExecutionTrust.filter((trust) => trust === "isolated");
  if (allowedExecutionTrust.length === 0) {
    return {
      kind: "blocked",
      reason:
        'This step inherits an attachment, which requires isolated execution, but the task\'s allowed execution trust does not include "isolated".',
    };
  }

  const baseCapabilities = requirements?.requiredCapabilities ?? [];
  const requiredCapabilities =
    attachmentSignal === "image" &&
    !baseCapabilities.includes("vision.image") &&
    baseCapabilities.length < 9
      ? [...baseCapabilities, "vision.image" as const]
      : baseCapabilities;

  return { kind: "requirements", requirements: { requiredCapabilities, allowedExecutionTrust } };
}
