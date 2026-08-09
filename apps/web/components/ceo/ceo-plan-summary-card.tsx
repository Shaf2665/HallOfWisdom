import Link from "next/link";
import type { CeoPlan, CeoPlanVersion } from "../../lib/api-schemas";
import { CeoPlanStatusBadge } from "./ceo-plan-status-badge";

export function CeoPlanSummaryCard({
  plan,
  version,
}: {
  readonly plan: CeoPlan;
  readonly version?: CeoPlanVersion;
}) {
  const orderedSteps = version
    ? [...version.steps].sort((left, right) => left.position - right.position)
    : [];

  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-stone-900 dark:border-amber-900/70 dark:bg-amber-950/20 dark:text-stone-100">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">Plan ready</h4>
        <CeoPlanStatusBadge status={plan.status} />
      </div>

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

      <Link
        href={`/ceo/${encodeURIComponent(plan.id)}`}
        className="mt-4 inline-flex rounded-lg bg-amber-700 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-800 dark:bg-amber-600 dark:hover:bg-amber-500"
      >
        Review full plan
      </Link>
    </div>
  );
}
