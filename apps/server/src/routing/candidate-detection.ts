import type { AgentRegistry } from "@hall-of-wisdom/hall-runner";
import type { RoutingCandidateInput } from "./routing-policy.js";

/**
 * Fresh, parallel `detect()` across every registered adapter, mapped to
 * the pure routing policy's input shape. Mirrors `routes/adapters.ts`'s
 * own `detectSafely`: one broken adapter's `detect()` must never fail the
 * whole routing analysis, and `executionTrust`/`capabilityObservations`
 * default to safe, unavailable/empty values when an adapter's `detect()`
 * throws or omits them (pre-Phase-11 test fakes). Deliberately not shared
 * code with `routes/adapters.ts`'s `detectSafely` — that function returns
 * the browser-facing `limitationNotice`-shaped summary, a different
 * concern from this module's routing-policy input shape.
 */
export async function detectRoutingCandidates(
  registry: AgentRegistry,
): Promise<RoutingCandidateInput[]> {
  const descriptors = [...registry.listDescriptors()].sort((a, b) =>
    a.adapterId.localeCompare(b.adapterId),
  );

  return Promise.all(
    descriptors.map(async (descriptor): Promise<RoutingCandidateInput> => {
      try {
        const adapter = registry.resolve(descriptor.adapterId);
        const detection = await adapter.detect();
        return {
          adapterId: descriptor.adapterId,
          displayName: descriptor.displayName,
          integrationLevel: descriptor.integrationLevel,
          availability: detection.availability,
          executionTrust: detection.executionTrust ?? "unavailable",
          capabilityObservations: detection.capabilityObservations ?? [],
        };
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.error(
          `adapter "${descriptor.adapterId}" detection failed during routing analysis: ${detail}`,
        );
        return {
          adapterId: descriptor.adapterId,
          displayName: descriptor.displayName,
          integrationLevel: descriptor.integrationLevel,
          availability: "unavailable",
          executionTrust: "unavailable",
          capabilityObservations: [],
        };
      }
    }),
  );
}
