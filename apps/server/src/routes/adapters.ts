import type { FastifyInstance } from "fastify";
import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import type {
  AgentAdapterDescriptor,
  AvailabilityStatus,
  IntegrationLevel,
  OperatingSystem,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type {
  AgentCapabilities,
  CapabilityId,
  CapabilityObservation,
  ExecutionTrust,
} from "@hall-of-wisdom/protocol";
import { AdapterNotFoundError } from "../errors/app-error.js";

export interface AdapterRoutesDeps {
  readonly registry: AgentRegistry;
}

/**
 * The browser-safe view of one registered adapter. Deliberately excludes
 * everything `AgentDetectionResult`/`AgentAdapter` can carry that isn't
 * safe to send to a client: `executablePath`, any raw error, environment
 * data, or the adapter instance itself.
 *
 * `limitationNotice` is the one deliberate, narrow exception to "never
 * send `diagnosticMessage` to a client" that predates this phase: it is
 * populated only when `availability === "available"`. Every adapter in
 * this codebase treats "available" as the outcome that needs no
 * explanation — a `diagnosticMessage` attached to an `available` result
 * is therefore, by construction, never raw captured process output
 * describing a problem; it is the adapter's own small, fixed,
 * hand-authored caveat about an otherwise-successful result.
 *
 * Phase 17.2 adds `installed`, `statusMessage`, and `detectedVersion` —
 * all three come straight from `AgentDetectionResult`'s own already-safe,
 * bounded fields (see that schema's doc comment in `agent-adapter-sdk`:
 * every adapter is contractually required to keep `diagnosticMessage`
 * free of unredacted output, never just "bounded"). `statusMessage`
 * widens exposure of the SAME underlying `diagnosticMessage` value to
 * every `availability`, not just `available` — a deliberate, additive
 * field with its own contract (used by the Providers page,
 * `apps/web/components/providers/`, to explain WHY a provider isn't
 * connected), never a change to `limitationNotice`'s existing, narrower,
 * still-fully-tested contract. All three are omitted (not `false`/empty
 * string) when `detect()` throws — see `detectSafely` below.
 *
 * Phase 11 additions follow the exact same safety discipline:
 * `capabilityObservations`/`executionTrust`/`limitations` are read
 * straight from `AgentDetectionResult` (already bounded, already
 * hand-authored, never raw process output — see that schema's own doc
 * comment in `agent-adapter-sdk`), never from anything a request carries.
 * `declaredCapabilities` is static descriptor metadata, not a live
 * observation. `assignable` and `detectedAt` are computed here, in this
 * route, not accepted from anywhere.
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
  readonly declaredCapabilities: readonly CapabilityId[];
  readonly installed: boolean;
  readonly availability: AvailabilityStatus;
  readonly assignable: boolean;
  readonly executionTrust: ExecutionTrust;
  readonly capabilityObservations: readonly CapabilityObservation[];
  readonly limitations: readonly string[];
  readonly detectedAt: string;
  readonly limitationNotice?: string;
  readonly statusMessage?: string;
  readonly detectedVersion?: string;
}

interface SafeDetectionSummary {
  readonly installed: boolean;
  readonly availability: AvailabilityStatus;
  readonly executionTrust: ExecutionTrust;
  readonly capabilityObservations: readonly CapabilityObservation[];
  readonly limitations: readonly string[];
  readonly limitationNotice?: string;
  readonly statusMessage?: string;
  readonly detectedVersion?: string;
}

/**
 * Calls `detect()` for one adapter, never letting a throw (or rejection)
 * escape: a misbehaving adapter must not take down the whole list, and
 * whatever it threw must not reach the client. The failure is logged
 * server-side, bounded, without any raw error object or stack trace.
 * `executionTrust` defaults to `"unavailable"` and the two arrays default
 * to `[]` when an adapter's `detect()` omits them (pre-Phase-11 fakes) or
 * throws — never left `undefined`, so every route/UI consumer can treat
 * these fields as always-present.
 */
async function detectSafely(
  registry: AgentRegistry,
  adapterId: string,
): Promise<SafeDetectionSummary> {
  try {
    const adapter = registry.resolve(adapterId);
    const result = await adapter.detect();
    return {
      installed: result.installed,
      availability: result.availability,
      executionTrust: result.executionTrust ?? "unavailable",
      capabilityObservations: result.capabilityObservations ?? [],
      limitations: result.limitations ?? [],
      ...(result.availability === "available" && result.diagnosticMessage !== undefined
        ? { limitationNotice: result.diagnosticMessage }
        : {}),
      ...(result.diagnosticMessage !== undefined
        ? { statusMessage: result.diagnosticMessage }
        : {}),
      ...(result.detectedVersion !== undefined
        ? { detectedVersion: result.detectedVersion }
        : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`adapter "${adapterId}" detection failed: ${detail}`);
    return {
      installed: false,
      availability: "unavailable",
      executionTrust: "unavailable",
      capabilityObservations: [],
      limitations: [],
    };
  }
}

/**
 * Builds the client-safe summary for one adapter from its static
 * descriptor and a fresh `SafeDetectionSummary`. Shared by the list route
 * below and by Task 2's single-adapter route — the summary shape is
 * assembled in exactly one place.
 */
function buildAdapterSummary(
  descriptor: AgentAdapterDescriptor,
  detection: SafeDetectionSummary,
): SafeAdapterSummary {
  const summary: SafeAdapterSummary = {
    adapterId: descriptor.adapterId,
    displayName: descriptor.displayName,
    adapterVersion: descriptor.adapterVersion,
    agentId: descriptor.supportedAgent.agentId,
    agentDisplayName: descriptor.supportedAgent.displayName,
    integrationLevel: descriptor.integrationLevel,
    supportedOperatingSystems: descriptor.supportedOperatingSystems,
    capabilities: descriptor.capabilities,
    declaredCapabilities: descriptor.declaredCapabilities,
    installed: detection.installed,
    availability: detection.availability,
    // Phase 11 — task-independent: whether *some* task could be
    // assigned to this adapter right now. Task-specific
    // capability/trust matching is `routing-policy.ts`'s job.
    assignable: detection.availability === "available",
    executionTrust: detection.executionTrust,
    capabilityObservations: detection.capabilityObservations,
    limitations: detection.limitations,
    detectedAt: new Date().toISOString(),
    ...(detection.limitationNotice !== undefined
      ? { limitationNotice: detection.limitationNotice }
      : {}),
    ...(detection.statusMessage !== undefined ? { statusMessage: detection.statusMessage } : {}),
    ...(detection.detectedVersion !== undefined
      ? { detectedVersion: detection.detectedVersion }
      : {}),
  };
  return descriptor.supportedAgent.provider === undefined
    ? summary
    : { ...summary, provider: descriptor.supportedAgent.provider };
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
        const detection = await detectSafely(deps.registry, descriptor.adapterId);
        return buildAdapterSummary(descriptor, detection);
      }),
    );

    return { adapters };
  });

  /**
   * `GET /api/v1/adapters/:adapterId`: the same safe summary as the list
   * route, for exactly one adapter — used by the Providers page's Recheck
   * action (Phase 17.2) so rechecking one provider never needs to
   * re-fetch or re-render every other one. Throws the same
   * `AdapterNotFoundError` `TaskOrchestrator`/`ComparisonOrchestrator`
   * already use for an unknown adapterId, so this route's 404 shape is
   * identical to every other resource-not-found response in this API.
   */
  app.get<{ Params: { adapterId: string } }>(
    "/api/v1/adapters/:adapterId",
    async (request) => {
      const { adapterId } = request.params;
      const descriptor = deps.registry
        .listDescriptors()
        .find((candidate) => candidate.adapterId === adapterId);
      if (descriptor === undefined) {
        throw new AdapterNotFoundError(adapterId);
      }
      const detection = await detectSafely(deps.registry, adapterId);
      return { adapter: buildAdapterSummary(descriptor, detection) };
    },
  );
}
