"use client";

import { useParams } from "next/navigation";
import { ApplicationShell } from "../../../components/application-shell";
import { ServerStatus } from "../../../components/server-status";
import { ComparisonDetail } from "../../../components/comparisons/comparison-detail";
import { resolveHallCoreUrl } from "../../../lib/hall-core-url";

const { httpUrl: BASE_URL, wsUrl: WS_BASE_URL } = resolveHallCoreUrl();

export default function ComparisonDetailPage() {
  const params = useParams();
  const rawComparisonId = params.comparisonId;
  const comparisonId: string | undefined = Array.isArray(rawComparisonId)
    ? rawComparisonId[0]
    : rawComparisonId;

  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      {comparisonId ? (
        <ComparisonDetail baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} comparisonId={comparisonId} />
      ) : (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          No comparison specified.
        </p>
      )}
    </ApplicationShell>
  );
}
