import { ApplicationShell } from "../../components/application-shell";
import { ServerStatus } from "../../components/server-status";
import { SettingsHub } from "../../components/settings/settings-hub";
import { resolveHallCoreUrl } from "../../lib/hall-core-url";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

export default function SettingsPage() {
  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      <SettingsHub baseUrl={BASE_URL} />
    </ApplicationShell>
  );
}
