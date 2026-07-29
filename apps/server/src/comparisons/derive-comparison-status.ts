import type { CandidateStatus, ComparisonStatus } from "./comparison-record.js";

/**
 * Recomputes the comparison-level status from its two candidates'
 * statuses — only ever transforms `ready`/`running`. Every other status
 * (`draft`/`preparing`/`failed`/`cancelled`/`cleaning`/`cleaned`) is a
 * fixed point set by its own dedicated store method and must never be
 * silently overwritten here — in particular, a candidate terminal event
 * that arrives after cleanup has already begun (the run was
 * abort-signalled but had not yet actually stopped) must not resurrect an
 * outcome status and clobber `cleaning`/`cleaned`.
 *
 * Extracted as a shared, pure function (Phase 13) so `ComparisonStore` and
 * `SqliteComparisonStore` apply the identical algorithm — this specific
 * piece of business logic is exactly the kind that would silently drift
 * between two hand-duplicated copies and produce a durable-mode-only bug.
 */
export function deriveComparisonStatus(
  currentStatus: ComparisonStatus,
  candidateStatuses: readonly [CandidateStatus, CandidateStatus],
): ComparisonStatus {
  if (currentStatus !== "ready" && currentStatus !== "running") {
    return currentStatus;
  }
  const allTerminal = candidateStatuses.every(
    (status) => status === "completed" || status === "failed" || status === "cancelled",
  );
  if (allTerminal) {
    return candidateStatuses.every((status) => status === "completed")
      ? "completed"
      : "partially_completed";
  }
  const anyProgressMade = candidateStatuses.some(
    (status) =>
      status === "running" ||
      status === "completed" ||
      status === "failed" ||
      status === "cancelled",
  );
  return anyProgressMade ? "running" : "ready";
}
