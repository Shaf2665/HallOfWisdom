import type { CeoPlanStatus } from "../../lib/api-schemas";

const CEO_PLAN_STATUS_LABELS: Record<CeoPlanStatus, string> = {
  draft: "Draft",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  delegated: "Delegated",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const FRIENDLY_CEO_PLAN_STATUS_LABELS: Record<CeoPlanStatus, string> = {
  draft: "Draft",
  awaiting_approval: "Ready for approval",
  approved: "Approved",
  rejected: "Changes needed",
  delegated: "Prepared",
  completed: "Completed",
  failed: "Needs attention",
  cancelled: "Cancelled",
};

const CEO_PLAN_STATUS_CLASSES: Record<CeoPlanStatus, string> = {
  draft: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  awaiting_approval: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  delegated: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  cancelled: "bg-stone-300 text-stone-800 dark:bg-stone-700 dark:text-stone-200",
};

export function CeoPlanStatusBadge({
  status,
  friendly = false,
}: {
  readonly status: CeoPlanStatus;
  readonly friendly?: boolean;
}) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${CEO_PLAN_STATUS_CLASSES[status]}`}
    >
      {(friendly ? FRIENDLY_CEO_PLAN_STATUS_LABELS : CEO_PLAN_STATUS_LABELS)[status]}
    </span>
  );
}
