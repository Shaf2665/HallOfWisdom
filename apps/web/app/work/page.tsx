import { ApplicationShell } from "../../components/application-shell";
import { ServerStatus } from "../../components/server-status";
import { WorkHub } from "../../components/work/work-hub";
import { resolveHallCoreUrl } from "../../lib/hall-core-url";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

export default function WorkPage() {
  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      <WorkHub baseUrl={BASE_URL} />
    </ApplicationShell>
  );
}
