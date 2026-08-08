import type { AdapterSummary } from "../../lib/api-schemas";

/** The two-state headline this page shows, per the target UX — everything else is guidance detail underneath. */
export type ConnectionState = "connected" | "not-connected";

export function deriveConnectionState(adapter: AdapterSummary): ConnectionState {
  return adapter.availability === "available" ? "connected" : "not-connected";
}

const FALLBACK_GUIDANCE_BY_AVAILABILITY: Record<AdapterSummary["availability"], string> = {
  available: "Ready to run tasks.",
  logged_out: "Installed, but not logged in yet.",
  unavailable: "Not detected on this machine.",
  busy: "Currently busy handling another request — try Recheck again shortly.",
  rate_limited: "Rate-limited by the provider right now — try Recheck again shortly.",
  offline: "The provider appears offline — check your network connection.",
  unsupported: "Not currently usable in this setup.",
};

/**
 * Plain-language guidance for why a provider is or isn't connected.
 * Prefers the adapter's own `statusMessage` (a fixed, hand-authored
 * sentence from that adapter's own `detect()` call — see
 * apps/server/src/routes/adapters.ts's `detectSafely`) over a generic
 * fallback keyed by `availability`, so this UI never re-derives or
 * guesses at detection logic itself — it only ever displays what the
 * server already computed.
 */
export function deriveGuidanceText(adapter: AdapterSummary): string {
  return adapter.statusMessage ?? FALLBACK_GUIDANCE_BY_AVAILABILITY[adapter.availability];
}

const CONNECT_COMMAND_BY_ADAPTER_ID: Record<string, string> = {
  "hall.claude-code": "claude login",
  "hall.codex": "codex login",
};

/**
 * The provider's own official login command — public documentation-level
 * knowledge, not detection logic. Returns `undefined` for an adapter with
 * no such flow (e.g. Mock Agent); callers must hide the Connect action in
 * that case.
 */
export function connectCommandFor(adapterId: string): string | undefined {
  return CONNECT_COMMAND_BY_ADAPTER_ID[adapterId];
}

const KNOWN_PROVIDER_ADAPTER_IDS: readonly string[] = ["hall.claude-code", "hall.codex"];

/**
 * The Providers page shows exactly Claude Code and Codex, matching the
 * target UX. Mock Agent and any future non-provider adapter are never
 * shown here — they belong on the `/agents` capability-comparison page
 * instead, which this phase does not modify.
 */
export function isKnownProviderAdapter(adapterId: string): boolean {
  return KNOWN_PROVIDER_ADAPTER_IDS.includes(adapterId);
}
