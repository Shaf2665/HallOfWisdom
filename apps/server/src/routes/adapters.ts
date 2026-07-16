import type { FastifyInstance } from "fastify";
import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import type {
  AvailabilityStatus,
  IntegrationLevel,
  OperatingSystem,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { AgentCapabilities } from "@hall-of-wisdom/protocol";

export interface AdapterRoutesDeps {
  readonly registry: AgentRegistry;
}

/**
 * The browser-safe view of one registered adapter. Deliberately excludes
 * everything `AgentDetectionResult`/`AgentAdapter` can carry that isn't
 * safe to send to a client: `executablePath`, `diagnosticMessage` (may
 * embed unredacted captured process output), any raw error, environment
 * data, or the adapter instance itself.
 */
interface SafeAdapterSummary {
  readonly adapterId: string;
  readonly displayName: string;
  readonly adapterVersion: string;
  readonly agentId: string;
  readonly agentDisplayName: string;
  readonly provider?: string;
  readonly integrationLevel: IntegrationLevel;
  readonly supportedOperatingSystems: readonly OperatingSystem[];
  readonly capabilities: AgentCapabilities;
  readonly availability: AvailabilityStatus;
}

/**
 * Calls `detect()` for one adapter, never letting a throw (or rejection)
 * escape: a misbehaving adapter must not take down the whole list, and
 * whatever it threw must not reach the client. The failure is logged
 * server-side, bounded, without any raw error object or stack trace.
 */
async function detectSafely(
  registry: AgentRegistry,
  adapterId: string,
): Promise<AvailabilityStatus> {
  try {
    const adapter = registry.resolve(adapterId);
    const result = await adapter.detect();
    return result.availability;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`adapter "${adapterId}" detection failed: ${detail}`);
    return "unavailable";
  }
}

/**
 * `GET /api/v1/adapters`: a provider-neutral, deterministic list of every
 * registered adapter. Never assumes `hall.mock-agent` is the only
 * possible adapter — the web client is expected to render whatever this
 * endpoint actually returns. Detection failures are isolated per adapter
 * (`Promise.allSettled`-equivalent via `detectSafely`'s own try/catch) so
 * one broken adapter's `detect()` never fails the whole request.
 */
export function registerAdapterRoutes(app: FastifyInstance, deps: AdapterRoutesDeps): void {
  app.get("/api/v1/adapters", async () => {
    const descriptors = [...deps.registry.listDescriptors()].sort((a, b) =>
      a.adapterId.localeCompare(b.adapterId),
    );

    const adapters: SafeAdapterSummary[] = await Promise.all(
      descriptors.map(async (descriptor) => {
        const availability = await detectSafely(deps.registry, descriptor.adapterId);
        const summary: SafeAdapterSummary = {
          adapterId: descriptor.adapterId,
          displayName: descriptor.displayName,
          adapterVersion: descriptor.adapterVersion,
          agentId: descriptor.supportedAgent.agentId,
          agentDisplayName: descriptor.supportedAgent.displayName,
          integrationLevel: descriptor.integrationLevel,
          supportedOperatingSystems: descriptor.supportedOperatingSystems,
          capabilities: descriptor.capabilities,
          availability,
        };
        return descriptor.supportedAgent.provider === undefined
          ? summary
          : { ...summary, provider: descriptor.supportedAgent.provider };
      }),
    );

    return { adapters };
  });
}
