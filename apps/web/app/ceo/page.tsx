"use client";

import { useSearchParams } from "next/navigation";
import { ApplicationShell } from "../../components/application-shell";
import { ServerStatus } from "../../components/server-status";
import { CeoPlansList } from "../../components/ceo/ceo-plans-list";
import { resolveHallCoreUrl } from "../../lib/hall-core-url";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

export default function CeoPlansPage() {
  const searchParams = useSearchParams();
  const parentTaskId = searchParams.get("parentTaskId");

  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      <CeoPlansList baseUrl={BASE_URL} {...(parentTaskId !== null ? { parentTaskId } : {})} />
    </ApplicationShell>
  );
}
