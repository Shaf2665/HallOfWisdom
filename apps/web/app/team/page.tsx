"use client";

import { ApplicationShell } from "../../components/application-shell";
import { ServerStatus } from "../../components/server-status";
import { AgentsCatalog } from "../../components/agents/agents-catalog";
import { resolveHallCoreUrl } from "../../lib/hall-core-url";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

/** Feature 8's "Team" destination — Agents is the only item behind it, so this reuses `/agents` directly. */
export default function TeamPage() {
  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      <AgentsCatalog baseUrl={BASE_URL} />
    </ApplicationShell>
  );
}
