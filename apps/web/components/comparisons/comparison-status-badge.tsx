import type { CandidateStatus, ComparisonStatus } from "../../lib/api-schemas";

const COMPARISON_STATUS_LABELS: Record<ComparisonStatus, string> = {
  draft: "Draft",
  preparing: "Preparing",
  ready: "Ready",
  running: "Running",
  partially_completed: "Partially completed",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  cleaning: "Cleaning up",
  cleaned: "Cleaned up",
};

const COMPARISON_STATUS_CLASSES: Record<ComparisonStatus, string> = {
  draft: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  preparing: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  ready: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  running: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  partially_completed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  cancelled: "bg-stone-300 text-stone-800 dark:bg-stone-700 dark:text-stone-200",
  cleaning: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  cleaned: "bg-stone-300 text-stone-800 dark:bg-stone-700 dark:text-stone-200",
};

export function ComparisonStatusBadge({ status }: { readonly status: ComparisonStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${COMPARISON_STATUS_CLASSES[status]}`}
    >
      {COMPARISON_STATUS_LABELS[status]}
    </span>
  );
}

const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  pending: "Pending",
  prepared: "Prepared",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const CANDIDATE_STATUS_CLASSES: Record<CandidateStatus, string> = {
  pending: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  prepared: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  running: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  cancelled: "bg-stone-300 text-stone-800 dark:bg-stone-700 dark:text-stone-200",
};

export function CandidateStatusBadge({ status }: { readonly status: CandidateStatus }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${CANDIDATE_STATUS_CLASSES[status]}`}
    >
      {CANDIDATE_STATUS_LABELS[status]}
    </span>
  );
}
