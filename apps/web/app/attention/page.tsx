import { ApplicationShell } from "../../components/application-shell";
import { ServerStatus } from "../../components/server-status";
import { AttentionInbox } from "../../components/attention-inbox";
import { resolveHallCoreUrl } from "../../lib/hall-core-url";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

export default function AttentionPage() {
  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      <AttentionInbox baseUrl={BASE_URL} />
    </ApplicationShell>
  );
}
