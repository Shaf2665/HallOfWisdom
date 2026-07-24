"use client";

import { ApplicationShell } from "../../components/application-shell";
import { ServerStatus } from "../../components/server-status";
import { ComparisonsList } from "../../components/comparisons/comparisons-list";
import { resolveHallCoreUrl } from "../../lib/hall-core-url";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

export default function ComparisonsPage() {
  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      <ComparisonsList baseUrl={BASE_URL} />
    </ApplicationShell>
  );
}
