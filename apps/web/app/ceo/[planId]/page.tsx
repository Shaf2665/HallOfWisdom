"use client";

import { useParams } from "next/navigation";
import { ApplicationShell } from "../../../components/application-shell";
import { ServerStatus } from "../../../components/server-status";
import { CeoPlanDetail } from "../../../components/ceo/ceo-plan-detail";
import { resolveHallCoreUrl } from "../../../lib/hall-core-url";

const { httpUrl: BASE_URL, wsUrl: WS_BASE_URL } = resolveHallCoreUrl();

export default function CeoPlanDetailPage() {
  const params = useParams();
  const rawPlanId = params.planId;
  const planId: string | undefined = Array.isArray(rawPlanId) ? rawPlanId[0] : rawPlanId;

  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      {planId ? (
        <CeoPlanDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} planId={planId} />
      ) : (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          No CEO plan specified.
        </p>
      )}
    </ApplicationShell>
  );
}
