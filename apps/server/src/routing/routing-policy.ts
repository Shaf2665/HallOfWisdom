import type { IntegrationLevel, AvailabilityStatus } from "@hall-of-wisdom/agent-adapter-sdk";
import type {
  CapabilityId,
  CapabilityObservation,
  ExecutionTrust,
  TaskRequirements,
} from "@hall-of-wisdom/protocol";

/**
 * Everything the pure routing policy needs about one adapter, already
 * resolved from a fresh `detect()` call by the caller (a route handler).
 * This module is deliberately I/O-free and provider-neutral: it never
 * imports `AgentRegistry`, `TaskStore`, or any adapter package, and never
 * reads `adapterId`/`provider` for anything but the documented, explicit
 * final tie-break — see "Deterministic Routing Policy" in
 * `docs/architecture/0011-agent-capabilities-trust-and-routing.md`.
 */
export interface RoutingCandidateInput {
  readonly adapterId: string;
  readonly displayName: string;
  readonly integrationLevel: IntegrationLevel;
  readonly availability: AvailabilityStatus;
  readonly executionTrust: ExecutionTrust;
  readonly capabilityObservations: readonly CapabilityObservation[];
}

export interface RoutingCandidate {
  readonly adapterId: string;
  readonly displayName: string;
  readonly availability: AvailabilityStatus;
  readonly assignable: boolean;
  readonly executionTrust: ExecutionTrust;
  readonly verifiedCapabilities: readonly CapabilityId[];
  readonly missingCapabilities: readonly CapabilityId[];
  readonly restrictedCapabilities: readonly CapabilityId[];
  readonly trustAllowed: boolean;
  readonly safeReason: string;
  readonly rank: number | undefined;
}

/**
 * The result of evaluating a single adapter against a task's requirements
 * — everything `RoutingCandidate` carries except `rank` (ranking only
 * makes sense across multiple candidates; see `evaluateRouting` below).
 * This is the one, shared eligibility check: `routing-analysis`,
 * `route-and-assign`, and manual `/assign` (Phase 11.1) all call
 * `evaluateCandidateEligibility` and none of them re-implement any part of
 * this logic themselves — see "Deterministic routing policy" in
 * `docs/architecture/0011-agent-capabilities-trust-and-routing.md`.
 */
export interface CandidateEligibility {
  readonly assignable: boolean;
  readonly executionTrust: ExecutionTrust;
  readonly verifiedCapabilities: readonly CapabilityId[];
  readonly missingCapabilities: readonly CapabilityId[];
  readonly restrictedCapabilities: readonly CapabilityId[];
  readonly trustAllowed: boolean;
  readonly eligible: boolean;
  readonly safeReason: string;
}

export interface RoutingResult {
  readonly candidates: readonly RoutingCandidate[];
  readonly recommendedAdapterId: string | undefined;
  readonly explanation: string;
}

/** Lower ranks first: `native` is the deepest, most structured integration. */
const INTEGRATION_LEVEL_RANK: Record<IntegrationLevel, number> = {
  native: 0,
  structured_cli: 1,
  ide_bridge: 2,
  interactive_cli: 3,
  restricted: 4,
  unsupported: 5,
};

/**
 * Lower ranks first. `unavailable` never appears here — a candidate with
 * `executionTrust: "unavailable"` is never eligible (its `availability`
 * cannot be `"available"` either, by every adapter's own contract), so it
 * never reaches the ranking step. `simulated` and `trusted_local` are not
 * "above"/"below" each other in any absolute sense — this ordering exists
 * only to make ranking deterministic when a task's `allowedExecutionTrust`
 * happens to permit more than one, and documents Hall's own judgment that
 * a real, sandboxed run is safer than either a real, sandbox-bypassing run
 * or a simulated one.
 */
const TRUST_SAFETY_RANK: Record<Exclude<ExecutionTrust, "unavailable">, number> = {
  isolated: 0,
  trusted_local: 1,
  simulated: 2,
};

function findObservation(
  observations: readonly CapabilityObservation[],
  capability: CapabilityId,
): CapabilityObservation | undefined {
  return observations.find((observation) => observation.capability === capability);
}

function classifyRequiredCapabilities(
  requiredCapabilities: readonly CapabilityId[],
  observations: readonly CapabilityObservation[],
): { verified: CapabilityId[]; missing: CapabilityId[]; restricted: CapabilityId[] } {
  const verified: CapabilityId[] = [];
  const missing: CapabilityId[] = [];
  const restricted: CapabilityId[] = [];
  for (const capability of requiredCapabilities) {
    const observation = findObservation(observations, capability);
    if (observation?.status === "verified") {
      verified.push(capability);
    } else if (observation?.status === "restricted") {
      restricted.push(capability);
    } else {
      // Covers: no observation at all, "declared", "unverified", and
      // "unsupported" — none of these count as a usable "yes" for
      // routing, even though some are shown separately elsewhere (the
      // `/agents` catalog) for descriptive purposes.
      missing.push(capability);
    }
  }
  return { verified, missing, restricted };
}

function buildSafeReason(candidate: {
  readonly displayName: string;
  readonly assignable: boolean;
  readonly missingCapabilities: readonly CapabilityId[];
  readonly restrictedCapabilities: readonly CapabilityId[];
  readonly trustAllowed: boolean;
  readonly executionTrust: ExecutionTrust;
  readonly eligible: boolean;
}): string {
  if (!candidate.assignable) {
    return `${candidate.displayName} is not currently available.`;
  }
  if (candidate.restrictedCapabilities.length > 0) {
    return `${candidate.displayName}'s required capabilities are currently restricted on this machine: ${candidate.restrictedCapabilities.join(", ")}.`;
  }
  if (candidate.missingCapabilities.length > 0) {
    return `${candidate.displayName} is missing required, verified capabilities: ${candidate.missingCapabilities.join(", ")}.`;
  }
  if (!candidate.trustAllowed) {
    return `${candidate.displayName}'s execution trust ("${candidate.executionTrust}") is not in this task's allowed list.`;
  }
  return `${candidate.displayName} meets every required capability and its execution trust ("${candidate.executionTrust}") is allowed.`;
}

/**
 * Deterministically evaluates one candidate against a task's
 * requirements — the single, shared compatibility check reused by
 * routing analysis, route-and-assign, and manual assignment. Never
 * mutates `requirements` or `input`; never widens `allowedExecutionTrust`
 * or drops a `requiredCapabilities` entry for any reason — an adapter
 * that cannot meet the requirements as given is ineligible, not
 * accommodated. `unverified`, `declared`, and `unsupported` capability
 * statuses (and no observation at all) all count as "missing" — only
 * `verified` counts as a usable "yes"; `restricted` is tracked and
 * reported separately, since it reflects a *diagnosed* reason, but
 * excludes the candidate exactly like "missing" does. See
 * `docs/architecture/0011-agent-capabilities-trust-and-routing.md`,
 * "Deterministic routing policy" for the full rule list this implements.
 */
export function evaluateCandidateEligibility(
  requirements: TaskRequirements,
  input: RoutingCandidateInput,
): CandidateEligibility {
  const assignable = input.availability === "available";
  const { verified, missing, restricted } = classifyRequiredCapabilities(
    requirements.requiredCapabilities,
    input.capabilityObservations,
  );
  const trustAllowed = requirements.allowedExecutionTrust.includes(input.executionTrust);
  const eligible = assignable && missing.length === 0 && restricted.length === 0 && trustAllowed;
  const safeReason = buildSafeReason({
    displayName: input.displayName,
    assignable,
    missingCapabilities: missing,
    restrictedCapabilities: restricted,
    trustAllowed,
    executionTrust: input.executionTrust,
    eligible,
  });
  return {
    assignable,
    executionTrust: input.executionTrust,
    verifiedCapabilities: verified,
    missingCapabilities: missing,
    restrictedCapabilities: restricted,
    trustAllowed,
    eligible,
    safeReason,
  };
}

/**
 * Deterministically evaluates every candidate against a task's
 * requirements and ranks the eligible ones. Ranking is meaningful only
 * for routing (which must pick a single recommendation among several
 * eligible candidates) — manual assignment (Phase 11.1) needs only
 * `evaluateCandidateEligibility`'s per-candidate result, never a rank.
 * See `docs/architecture/0011-agent-capabilities-trust-and-routing.md`,
 * "Deterministic routing policy" for the full rule list this implements.
 */
export function evaluateRouting(
  requirements: TaskRequirements,
  candidates: readonly RoutingCandidateInput[],
): RoutingResult {
  const evaluated = candidates.map((input) => ({
    input,
    ...evaluateCandidateEligibility(requirements, input),
  }));

  const eligibleSorted = evaluated
    .filter((candidate) => candidate.eligible)
    .slice()
    .sort((a, b) => {
      const trustDiff =
        TRUST_SAFETY_RANK[a.input.executionTrust as Exclude<ExecutionTrust, "unavailable">] -
        TRUST_SAFETY_RANK[b.input.executionTrust as Exclude<ExecutionTrust, "unavailable">];
      if (trustDiff !== 0) return trustDiff;

      const integrationDiff =
        INTEGRATION_LEVEL_RANK[a.input.integrationLevel] -
        INTEGRATION_LEVEL_RANK[b.input.integrationLevel];
      if (integrationDiff !== 0) return integrationDiff;

      const aCancellationVerified =
        findObservation(a.input.capabilityObservations, "cancellation")?.status === "verified";
      const bCancellationVerified =
        findObservation(b.input.capabilityObservations, "cancellation")?.status === "verified";
      if (aCancellationVerified !== bCancellationVerified) {
        return aCancellationVerified ? -1 : 1;
      }

      return a.input.adapterId.localeCompare(b.input.adapterId);
    });

  const rankByAdapterId = new Map<string, number>();
  eligibleSorted.forEach((candidate, index) => {
    rankByAdapterId.set(candidate.input.adapterId, index + 1);
  });

  const recommended = eligibleSorted[0];
  const recommendedAdapterId = recommended?.input.adapterId;

  const candidateResults: RoutingCandidate[] = evaluated.map((candidate) => ({
    adapterId: candidate.input.adapterId,
    displayName: candidate.input.displayName,
    availability: candidate.input.availability,
    assignable: candidate.assignable,
    executionTrust: candidate.input.executionTrust,
    verifiedCapabilities: candidate.verifiedCapabilities,
    missingCapabilities: candidate.missingCapabilities,
    restrictedCapabilities: candidate.restrictedCapabilities,
    trustAllowed: candidate.trustAllowed,
    safeReason: candidate.safeReason,
    rank: rankByAdapterId.get(candidate.input.adapterId),
  }));

  const explanation =
    recommended !== undefined
      ? `Recommended "${recommended.input.displayName}": ${recommended.safeReason}`
      : "No adapter currently qualifies for this task's requirements.";

  return { candidates: candidateResults, recommendedAdapterId, explanation };
}
