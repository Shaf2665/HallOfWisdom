"use client";

import { Suspense } from "react";
import { ApplicationShell } from "../../components/application-shell";
import { ServerStatus } from "../../components/server-status";
import { CommunicationBoards } from "../../components/communication/communication-boards";
import { resolveHallCoreUrl } from "../../lib/hall-core-url";

const { httpUrl: BASE_URL, wsUrl: WS_BASE_URL } = resolveHallCoreUrl();

export default function BoardsPage() {
  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      {/* useSearchParams (inside CommunicationBoards) requires a Suspense
          boundary for Next.js static export — see app router docs. */}
      <Suspense fallback={<p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>}>
        <CommunicationBoards baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />
      </Suspense>
    </ApplicationShell>
  );
}
