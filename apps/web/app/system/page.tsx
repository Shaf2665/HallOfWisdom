"use client";

import { ApplicationShell } from "../../components/application-shell";
import { ServerStatus } from "../../components/server-status";
import { StorageStatus } from "../../components/system/storage-status";
import { resolveHallCoreUrl } from "../../lib/hall-core-url";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

export default function SystemPage() {
  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      <StorageStatus baseUrl={BASE_URL} />
    </ApplicationShell>
  );
}
