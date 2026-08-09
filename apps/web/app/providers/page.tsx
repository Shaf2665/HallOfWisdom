"use client";

import { ApplicationShell } from "../../components/application-shell";
import { ServerStatus } from "../../components/server-status";
import { ProvidersPanel } from "../../components/providers/providers-panel";
import { resolveHallCoreUrl } from "../../lib/hall-core-url";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

export default function ProvidersPage() {
  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      <ProvidersPanel baseUrl={BASE_URL} />
    </ApplicationShell>
  );
}
