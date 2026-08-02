import type {
  CeoPlanExecutionCircuitTripReason,
  CeoPlanExecutionPolicy,
} from "@hall-of-wisdom/protocol";

/**
 * A safety mechanism, not an AI judgement system (kickoff, "No-progress
 * circuit breaker") — every input here is a small, deterministic,
 * already-persisted counter; nothing here inspects raw provider output or
 * makes a qualitative judgement about *why* something failed. Two of the
 * protocol's five documented trip reasons (`rapid_attempt_churn`,
 * `adapter_flapping`) are intentionally not implemented in Phase 15 —
 * they require windowed/statistical tracking this phase does not build;
 * `consecutive_failures`, `consecutive_same_code_failures`, and
 * `no_progress_retries` cover the core requirement ("stop a plan that is
 * making no progress"). `half_open` is likewise not implemented — the
 * kickoff calls it out as "only if genuinely necessary," and every
 * documented resume path already requires explicit operator action, which
 * is a stronger guarantee than an automatic half-open probe would give.
 */
export interface CircuitEvaluationInput {
  readonly policy: CeoPlanExecutionPolicy;
  readonly consecutiveFailures: number;
  readonly consecutiveSameCodeFailures: number;
  readonly noProgressAttempts: number;
}

export interface CircuitEvaluation {
  readonly shouldTrip: boolean;
  readonly reason?: CeoPlanExecutionCircuitTripReason;
}

export function evaluateCircuitBreaker(input: CircuitEvaluationInput): CircuitEvaluation {
  // Same-code is checked BEFORE the general consecutive-failures count,
  // not after. `consecutiveSameCodeFailures` can never exceed
  // `consecutiveFailures` (it resets to 1 on any code change; the general
  // counter never resets on a code change) — so under the shared
  // `maxConsecutiveFailures` threshold, checking the general count first
  // would make `consecutive_same_code_failures` structurally unreachable:
  // whenever every failure shares one code the two counters climb
  // together and the general branch would always win the race. Checking
  // same-code first makes both reasons genuinely reachable: an unbroken
  // run of one identical code reports the more specific
  // `consecutive_same_code_failures`, while a run of changing codes (whose
  // same-code counter keeps resetting below threshold) still correctly
  // reports `consecutive_failures` once the general count gets there.
  if (input.consecutiveSameCodeFailures >= input.policy.maxConsecutiveFailures) {
    return { shouldTrip: true, reason: "consecutive_same_code_failures" };
  }
  if (input.consecutiveFailures >= input.policy.maxConsecutiveFailures) {
    return { shouldTrip: true, reason: "consecutive_failures" };
  }
  if (input.noProgressAttempts >= input.policy.maxNoProgressAttempts) {
    return { shouldTrip: true, reason: "no_progress_retries" };
  }
  return { shouldTrip: false };
}

export interface ProgressFingerprintInput {
  readonly childTaskStatus: string;
  readonly lastEventSequence: number | undefined;
  readonly hasTerminalResultEvidence: boolean;
  readonly dependencyCompletedCount: number;
}

/**
 * Deterministic, bounded fingerprint of a step's observable progress —
 * built only from already-safe, already-bounded fields (kickoff: never
 * raw provider output, hidden reasoning, full diffs, auth data, absolute
 * paths, or a timestamp alone). Two attempts with an identical fingerprint
 * made no discernible progress between them; comparing consecutive
 * fingerprints (not just "did it fail again") is what lets the scheduler
 * distinguish "waiting on a slow but healthy adapter" from "genuinely
 * stuck," without ever reading the adapter's actual output.
 */
export function computeProgressFingerprint(input: ProgressFingerprintInput): string {
  return [
    input.childTaskStatus,
    String(input.lastEventSequence ?? -1),
    input.hasTerminalResultEvidence ? "1" : "0",
    String(input.dependencyCompletedCount),
  ].join(":");
}
