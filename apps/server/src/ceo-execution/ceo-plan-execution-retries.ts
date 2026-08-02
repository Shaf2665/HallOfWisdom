import type {
  CeoPlanExecutionFailureClassification,
  CeoPlanExecutionPolicy,
  StructuredFailure,
} from "@hall-of-wisdom/protocol";

/**
 * Exhaustive classification of why a step attempt did not succeed.
 * Deliberately never inspects raw error *text* — only the adapter's own
 * honest, already-safe `StructuredFailure.retryable` hint (set by the
 * adapter/orchestrator itself, never guessed from a message string) plus
 * a small set of known, stable failure codes. "Do not retry based only on
 * matching error text" (kickoff, "Retry classification").
 */
export type ClassifiableOutcome =
  | { readonly kind: "structured_failure"; readonly failure: StructuredFailure }
  | { readonly kind: "adapter_unavailable" }
  | { readonly kind: "ownership_lost" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "requirements_changed" };

const SECURITY_CODES = new Set([
  "TRUST_VIOLATION",
  "SECURITY_POLICY_VIOLATION",
  "UNTRUSTED_ADAPTER_BLOCKED",
]);

export function classifyExecutionFailure(
  outcome: ClassifiableOutcome,
): CeoPlanExecutionFailureClassification {
  switch (outcome.kind) {
    case "adapter_unavailable":
      return "adapter_unavailable";
    case "ownership_lost":
      return "ownership_lost";
    case "cancelled":
      return "cancelled";
    case "requirements_changed":
      return "requirements_changed";
    case "structured_failure": {
      const { failure } = outcome;
      if (SECURITY_CODES.has(failure.code)) return "security";
      if (failure.retryable === true) return "transient";
      if (failure.retryable === false) return "permanent";
      return "unknown";
    }
  }
}

export interface RetryDecisionInput {
  readonly classification: CeoPlanExecutionFailureClassification;
  readonly policy: CeoPlanExecutionPolicy;
  readonly attemptNumber: number;
}

export interface RetryDecision {
  readonly shouldRetry: boolean;
  /** Present only when `shouldRetry` is `true` — the earliest ISO timestamp a retry signal becomes eligible. */
  readonly nextEligibleAt?: string;
}

/**
 * The one place retry eligibility is decided — every classification
 * except `transient` is permanently non-retryable, matching the
 * kickoff's per-classification policy table exactly (permanent/security/
 * ownership_lost/cancelled/requirements_changed/unknown never retry
 * automatically; adapter_unavailable is handled separately by the
 * scheduler's own bounded backoff-and-recheck, not this bounded-attempt
 * path, since it is not attempt-count-bounded the same way).
 */
export function decideRetry(input: RetryDecisionInput, now: string): RetryDecision {
  if (input.classification !== "transient") return { shouldRetry: false };
  if (!input.policy.allowAutomaticTransientRetry) return { shouldRetry: false };
  if (input.attemptNumber >= input.policy.maxAttemptsPerStep) return { shouldRetry: false };
  const nextEligibleAt = new Date(
    new Date(now).getTime() + input.policy.retryBackoffSeconds * 1000,
  ).toISOString();
  return { shouldRetry: true, nextEligibleAt };
}
