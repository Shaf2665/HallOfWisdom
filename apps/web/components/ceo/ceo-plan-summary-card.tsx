import Link from "next/link";
import type { CeoPlan, CeoPlanVersion } from "../../lib/api-schemas";
import { CeoPlanStatusBadge } from "./ceo-plan-status-badge";

type PlanAction = "continuing" | "approving";

function planStatusCopy(status: CeoPlan["status"]): string {
  switch (status) {
    case "draft":
      return "Your plan is ready to review.";
    case "awaiting_approval":
      return "The plan is ready for your approval.";
    case "approved":
      return "Plan approved. Hall is ready to delegate the work.";
    case "rejected":
      return "The plan needs a few changes before it can continue.";
    case "delegated":
      return "Hall has prepared the work from this plan.";
    case "completed":
      return "The work in this plan is complete.";
    case "failed":
      return "This plan needs attention. Review the full plan to see what happened.";
    case "cancelled":
      return "This plan has been cancelled.";
  }
}

export function CeoPlanSummaryCard({
  plan,
  version,
  activeAction,
  actionError,
  actionsDisabled,
  canContinue,
  canApprove,
  approvalConfirmed,
  onContinue,
  onApprovalConfirmedChange,
  onApprove,
}: {
  readonly plan: CeoPlan;
  readonly version?: CeoPlanVersion;
  readonly activeAction: PlanAction | null;
  readonly actionError: string | null;
  readonly actionsDisabled: boolean;
  readonly canContinue: boolean;
  readonly canApprove: boolean;
  readonly approvalConfirmed: boolean;
  readonly onContinue: () => void;
  readonly onApprovalConfirmedChange: (confirmed: boolean) => void;
  readonly onApprove: () => void;
}) {
  const orderedSteps = version
    ? [...version.steps].sort((left, right) => left.position - right.position)
    : [];

  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-stone-900 dark:border-amber-900/70 dark:bg-amber-950/20 dark:text-stone-100">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">
          {plan.status === "approved" ? "Plan approved" : "Plan ready"}
        </h4>
        <CeoPlanStatusBadge status={plan.status} />
      </div>

      <p className="mt-2 text-sm leading-6 text-stone-700 dark:text-stone-200">
        {planStatusCopy(plan.status)}
      </p>

      {version ? (
        <div className="mt-3 space-y-3">
          <div>
            <p className="font-medium leading-6">{version.objective}</p>
            <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-stone-300">
              {version.summary}
            </p>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-sm leading-6">
            {orderedSteps.map((step) => (
              <li key={step.id}>{step.title}</li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">
          The plan is ready, but its details couldn’t be loaded here.
        </p>
      )}

      {actionError ? (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-amber-300 bg-amber-100/70 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
        >
          {actionError}
        </p>
      ) : null}

      {plan.status === "draft" ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={actionsDisabled || !canContinue}
            onClick={onContinue}
            className="rounded-lg bg-amber-700 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-600 dark:hover:bg-amber-500"
          >
            {activeAction === "continuing" ? "Continuing…" : "Continue"}
          </button>
          <Link
            href={`/ceo/${encodeURIComponent(plan.id)}`}
            className="rounded-lg border border-amber-300 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-100 dark:hover:bg-amber-950/60"
          >
            Review full plan
          </Link>
        </div>
      ) : null}

      {plan.status === "awaiting_approval" ? (
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-2 text-sm leading-5 text-stone-700 dark:text-stone-200">
            <input
              type="checkbox"
              checked={approvalConfirmed}
              disabled={actionsDisabled || !canApprove}
              onChange={(event) => {
                onApprovalConfirmedChange(event.target.checked);
              }}
              className="mt-0.5"
            />
            <span>I understand that approving this plan does not start any work yet.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={actionsDisabled || !canApprove || !approvalConfirmed}
              onClick={onApprove}
              className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-600 dark:hover:bg-emerald-500"
            >
              {activeAction === "approving" ? "Approving…" : "Approve plan"}
            </button>
            <Link
              href={`/ceo/${encodeURIComponent(plan.id)}`}
              className="rounded-lg border border-amber-300 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-100 dark:hover:bg-amber-950/60"
            >
              Review full plan
            </Link>
          </div>
        </div>
      ) : null}

      {(plan.status === "draft" && !canContinue) ||
      (plan.status === "awaiting_approval" && !canApprove) ? (
        <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">
          Plan actions couldn’t be loaded. Reload this page, or review the full plan.
        </p>
      ) : null}

      {plan.status !== "draft" &&
      plan.status !== "awaiting_approval" &&
      plan.status !== "approved" ? (
        <Link
          href={`/ceo/${encodeURIComponent(plan.id)}`}
          className="mt-4 inline-flex rounded-lg border border-amber-300 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-100 dark:hover:bg-amber-950/60"
        >
          Review full plan
        </Link>
      ) : null}
    </div>
  );
}
