import { ApplicationShell } from "../components/application-shell";
import { ServerStatus } from "../components/server-status";
import { WisdomGateway } from "../components/wisdom-gateway";
import { resolveHallCoreUrl } from "../lib/hall-core-url";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

export default function HomePage() {
  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      <WisdomGateway baseUrl={BASE_URL} />
    </ApplicationShell>
  );
}
