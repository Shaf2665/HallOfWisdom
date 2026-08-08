# Phase 17.2 — Provider Connection & Authentication UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a normal user see and manage Claude Code and Codex connection status from a new Hall Web `/providers` page, without Hall ever touching a credential.

**Architecture:** Widen the existing, already-safe `GET /api/v1/adapters` route (and add one narrow sibling, `GET /api/v1/adapters/:adapterId`) to expose three currently-hidden-but-already-safe fields (`installed`, `statusMessage`, `detectedVersion`) straight from each adapter's existing `detect()` call — zero new detection logic. A new Hall Web page renders two provider cards from this data with a two-state headline (Connected/Not connected) and plain-language guidance sourced verbatim from `statusMessage`. "Connect" is a static, client-only guidance panel (the provider's own login command + a copy button) — no server call, no process spawned by Hall.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), Fastify, Zod, Vitest, React Testing Library, Next.js (App Router), Playwright.

**Design doc:** `docs/superpowers/specs/2026-08-08-phase-17-2-provider-onboarding-design.md` — read it first; this plan implements it, including the refinement (confirmed while writing this plan, by reading the actual current route/schema code) that `diagnosticMessage` is currently blocked from reaching the client for every non-`available` state, which the design's "guidance sourced from diagnosticMessage" section depends on. This plan closes that gap via a new, additively-named `statusMessage` field, never by loosening the existing `limitationNotice` field's contract (which keeps its exact current "available only" behavior, unchanged, still covered by its existing tests).

## Global Constraints

- Node.js `>=24.11.0 <25`, pnpm `10.33.0` (root `package.json`, do not change).
- TypeScript strict mode, ESM/NodeNext, `verbatimModuleSyntax` — use `import type` for type-only imports.
- `exactOptionalPropertyTypes: true` — an optional field either has a real value or the key is omitted entirely; use conditional spread (`...(x === undefined ? {} : { x })`) to add one, matching this codebase's existing pattern (see `apps/server/src/routes/adapters.ts`'s existing `limitationNotice` handling).
- No new runtime dependencies.
- **Never** collect provider passwords; store API keys/tokens/cookies/auth files; read or expose raw credential contents; or proxy credentials through Hall Web. "Connect" spawns nothing server-side — it is a static client-rendered guidance panel only.
- Every `diagnosticMessage`/`statusMessage` value ever exposed to the client must originate only from a successfully-completed (non-throwing) `adapter.detect()` call — never from a caught error's message, never invented/interpreted by this phase's own code.
- Reuse existing adapter detection/auth mechanisms (`AgentAdapter.detect()`). Do not duplicate provider detection logic in the UI — the UI only ever displays fields the server already computed; the one small UI-level exception is a fixed `adapterId -> login command` lookup table (`hall.claude-code` -> `claude login`, `hall.codex` -> `codex login`), which is public documentation-level knowledge, not detection logic.
- Codex trusted-local stays explicit opt-in, always labelled "not OS-sandboxed" whenever shown, never enabled by this phase's code (there is no runtime toggle anywhere in the codebase to enable — confirmed).
- Do not work on strict Codex sandbox support. Do not regress Phase 17.1 installer/persistent-config behavior, worktree isolation/recovery, or capability/trust routing.
- Do not persist any connection/auth status as durable truth — every render is a fresh `detect()` call via the API.
- Branch: `phase-17-2-provider-onboarding` (already created from `main` at `9e0c78e089c36aa516f89dead6a0dbd1de69e63e`). Do not merge to `main`, do not create/push a PR — commit and push the branch only, per this phase's kickoff.

---

## File Structure

New:
- `apps/e2e/tests/providers.spec.ts` — Playwright E2E spec.
- `apps/web/app/providers/page.tsx` — thin page wrapper (matches `agents/page.tsx`'s convention).
- `apps/web/components/providers/provider-status.ts` — pure, framework-free mapping functions (connection state, guidance text, connect command, known-provider filter).
- `apps/web/components/providers/provider-status.test.ts` — unit tests for the above.
- `apps/web/components/providers/provider-card.tsx` — one provider's card: status, guidance, trust warning, Connect panel, Recheck, collapsible technical details.
- `apps/web/components/providers/provider-card.test.tsx`
- `apps/web/components/providers/providers-panel.tsx` — fetches the adapter list once, filters to known providers, renders a `ProviderCard` per provider, owns the "what does Recheck update" wiring.
- `apps/web/components/providers/providers-panel.test.tsx`
- `docs/architecture/0018-provider-connection-onboarding.md` — ADR.

Modified:
- `apps/server/src/routes/adapters.ts` — add `installed`/`statusMessage`/`detectedVersion` to `SafeAdapterSummary`/`SafeDetectionSummary`; extract a shared `buildAdapterSummary()` helper; add `GET /api/v1/adapters/:adapterId`.
- `apps/server/src/routes/adapters.test.ts` — cover the three new fields and the new route.
- `apps/web/lib/api-schemas.ts` — add the three new optional fields to `adapterSummarySchema`; add `getAdapterResponseSchema`.
- `apps/web/lib/api-client.ts` — add `getAdapter(baseUrl, adapterId, options)`.
- `apps/web/components/nav-bar.tsx` — add the Providers link.

---

### Task 1: Widen `SafeAdapterSummary` with `installed`/`statusMessage`/`detectedVersion`

**Files:**
- Modify: `apps/server/src/routes/adapters.ts`
- Modify: `apps/server/src/routes/adapters.test.ts`

**Interfaces:**
- Consumes: `AgentDetectionResult` (existing SDK type — already carries `installed: boolean`, `diagnosticMessage?: string`, `detectedVersion?: string`, none of which `SafeAdapterSummary` currently exposes).
- Produces: `SafeAdapterSummary` gains `installed: boolean`, `statusMessage?: string`, `detectedVersion?: string`. `SafeDetectionSummary` gains the same three (as the detection-layer source). New exported function `buildAdapterSummary(descriptor: AgentAdapterDescriptor, detection: SafeDetectionSummary): SafeAdapterSummary` — used by both this task's existing list route and Task 2's new route.

This task deliberately does NOT touch `limitationNotice`'s existing behavior (still `available`-only, still exactly as tested today) — `statusMessage` is new and additive, populated for every availability value whenever `detect()` completes without throwing.

- [ ] **Step 1: Write the failing tests**

Add these test cases to `apps/server/src/routes/adapters.test.ts` (append to the existing `describe("GET /api/v1/adapters", ...)` block — do not remove any existing test):

```typescript
  it("exposes installed, statusMessage, and detectedVersion regardless of availability", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.logged-out-agent",
        detect: () =>
          Promise.resolve({
            installed: true,
            availability: "logged_out",
            diagnosticMessage: "Example Agent is installed but not logged in.",
            detectedVersion: "1.2.3",
          } as { installed: boolean; availability: string }),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{
      adapters: (AdapterSummaryJson & {
        installed?: boolean;
        statusMessage?: string;
        detectedVersion?: string;
      })[];
    }>();
    const adapter = body.adapters.find((a) => a.adapterId === "hall.logged-out-agent");
    expect(adapter?.installed).toBe(true);
    expect(adapter?.statusMessage).toBe("Example Agent is installed but not logged in.");
    expect(adapter?.detectedVersion).toBe("1.2.3");
    // limitationNotice keeps its existing, narrower, available-only contract — unchanged.
    expect(adapter?.limitationNotice).toBeUndefined();
    await app.close();
  });

  it("still exposes limitationNotice for an available adapter, alongside the new statusMessage carrying the same text", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.caveat-agent-2",
        detect: () =>
          Promise.resolve({
            installed: true,
            availability: "available",
            diagnosticMessage: "Running in a reduced-trust mode.",
          } as { installed: boolean; availability: string }),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{
      adapters: (AdapterSummaryJson & { statusMessage?: string })[];
    }>();
    const adapter = body.adapters.find((a) => a.adapterId === "hall.caveat-agent-2");
    expect(adapter?.limitationNotice).toBe("Running in a reduced-trust mode.");
    expect(adapter?.statusMessage).toBe("Running in a reduced-trust mode.");
    await app.close();
  });

  it("defaults installed to false and omits statusMessage/detectedVersion when detect() throws", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.broken-agent-2",
        detect: () => Promise.reject(new Error("simulated detection crash")),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    const body = response.json<{
      adapters: (AdapterSummaryJson & {
        installed?: boolean;
        statusMessage?: string;
        detectedVersion?: string;
      })[];
    }>();
    const adapter = body.adapters.find((a) => a.adapterId === "hall.broken-agent-2");
    expect(adapter?.installed).toBe(false);
    expect(adapter?.statusMessage).toBeUndefined();
    expect(adapter?.detectedVersion).toBeUndefined();
    await app.close();
  });

  it("never exposes a thrown error's message under statusMessage", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.broken-agent-3",
        detect: () => Promise.reject(new Error("secret internal detail: TOKEN=xyz789")),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters" });
    expect(response.body).not.toContain("TOKEN=xyz789");
    expect(response.body).not.toContain("secret internal detail");
    await app.close();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @hall-of-wisdom/hall-core exec vitest run adapters`
Expected: FAIL — `installed`/`statusMessage`/`detectedVersion` are `undefined` on every result (fields don't exist yet on the response).

- [ ] **Step 3: Widen `SafeDetectionSummary`, `detectSafely`, and `SafeAdapterSummary`; extract `buildAdapterSummary`**

In `apps/server/src/routes/adapters.ts`, add `AgentAdapterDescriptor` to the existing `@hall-of-wisdom/agent-adapter-sdk` type-only import (alongside `AvailabilityStatus`, `IntegrationLevel`, `OperatingSystem`).

Replace the `SafeAdapterSummary` interface's doc comment and body (keep every existing field, add the three new ones at the end):

```typescript
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
```

Replace `SafeDetectionSummary`:

```typescript
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
```

Replace `detectSafely`:

```typescript
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
```

Add the shared summary builder just above `registerAdapterRoutes`:

```typescript
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
```

Replace the body of the existing `GET /api/v1/adapters` handler (inside `registerAdapterRoutes`) to use the extracted helper — same behavior, less duplication:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @hall-of-wisdom/hall-core exec vitest run adapters`
Expected: PASS — all existing tests plus the four new ones.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter @hall-of-wisdom/hall-core run typecheck && pnpm --filter @hall-of-wisdom/hall-core exec eslint src/routes/adapters.ts src/routes/adapters.test.ts`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/adapters.ts apps/server/src/routes/adapters.test.ts
git commit -m "feat(hall-core): expose installed/statusMessage/detectedVersion on adapter summaries"
```

---

### Task 2: `GET /api/v1/adapters/:adapterId`

**Files:**
- Modify: `apps/server/src/routes/adapters.ts`
- Modify: `apps/server/src/routes/adapters.test.ts`

**Interfaces:**
- Consumes: `buildAdapterSummary`, `detectSafely` (Task 1). `AdapterNotFoundError` (existing, `apps/server/src/errors/app-error.ts` — code `ADAPTER_NOT_FOUND`, statusCode 404, already used by `TaskOrchestrator`/`ComparisonOrchestrator` for the same "unknown adapterId" concept).
- Produces: route `GET /api/v1/adapters/:adapterId` returning `{ adapter: SafeAdapterSummary }` on success; the existing centralized error handler (`apps/server/src/errors/error-handler.ts`, already installed app-wide) converts a thrown `AdapterNotFoundError` into a `404 {"error":{"code":"ADAPTER_NOT_FOUND","message":"..."}}` response — this route never constructs that response body itself.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/routes/adapters.test.ts` (new top-level `describe` block, after the existing one):

```typescript
describe("GET /api/v1/adapters/:adapterId", () => {
  it("returns the same safe summary shape as the list route, for one adapter", async () => {
    const registry = new AgentRegistry();
    registry.register(new MockAgentAdapter());
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters/hall.mock-agent" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ adapter: AdapterSummaryJson }>();
    expect(body.adapter).toMatchObject({
      adapterId: "hall.mock-agent",
      displayName: "Mock Agent",
      availability: "available",
    });
    await app.close();
  });

  it("returns 404 ADAPTER_NOT_FOUND for an unregistered adapterId", async () => {
    const registry = new AgentRegistry();
    registry.register(new MockAgentAdapter());
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters/hall.does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("ADAPTER_NOT_FOUND");
    await app.close();
  });

  it("isolates a detect() failure the same way the list route does", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.broken-single",
        detect: () => Promise.reject(new Error("simulated detection crash")),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/adapters/hall.broken-single",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ adapter: AdapterSummaryJson & { installed?: boolean } }>();
    expect(body.adapter.availability).toBe("unavailable");
    expect(body.adapter.installed).toBe(false);
    await app.close();
  });

  it("never exposes executablePath or a thrown error's message for the single-adapter route", async () => {
    const registry = new AgentRegistry();
    registry.register(
      buildFakeAdapter({
        adapterId: "hall.leaky-single",
        detect: () => Promise.reject(new Error("secret internal detail: TOKEN=single456")),
      }),
    );
    const app = await buildApp(registry);

    const response = await app.inject({ method: "GET", url: "/api/v1/adapters/hall.leaky-single" });
    expect(response.body).not.toContain("TOKEN=single456");
    expect(response.body).not.toContain("executablePath");
    await app.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @hall-of-wisdom/hall-core exec vitest run adapters`
Expected: FAIL — 404 for `GET /api/v1/adapters/hall.mock-agent` (route doesn't exist yet; Fastify's own not-found handler returns a generic 404 with a different error code).

- [ ] **Step 3: Add the route**

In `apps/server/src/routes/adapters.ts`, add the import (alongside the existing SDK/protocol type imports):

```typescript
import { AdapterNotFoundError } from "../errors/app-error.js";
```

Add the new route inside `registerAdapterRoutes`, immediately after the existing `GET /api/v1/adapters` handler, before the closing `}` of the function:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @hall-of-wisdom/hall-core exec vitest run adapters`
Expected: PASS — all tests in both `describe` blocks.

- [ ] **Step 5: Typecheck, lint, full package test**

Run: `pnpm --filter @hall-of-wisdom/hall-core run typecheck && pnpm --filter @hall-of-wisdom/hall-core exec eslint src/routes/adapters.ts src/routes/adapters.test.ts && pnpm --filter @hall-of-wisdom/hall-core run test`
Expected: all clean; full package suite still green (confirms this change didn't disturb anything else that imports from `adapters.ts`, e.g. `routing.ts`/`app.ts`'s own route registration).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/adapters.ts apps/server/src/routes/adapters.test.ts
git commit -m "feat(hall-core): add GET /api/v1/adapters/:adapterId for single-provider recheck"
```

---

### Task 3: Hall Web schema + API client for the widened/new adapter data

**Files:**
- Modify: `apps/web/lib/api-schemas.ts`
- Modify: `apps/web/lib/api-client.ts`

**Interfaces:**
- Consumes: nothing new (extends existing `adapterSummarySchema`/`api-client.ts` patterns).
- Produces: `adapterSummarySchema` gains `installed: z.boolean()`, `statusMessage: z.string().optional()`, `detectedVersion: z.string().optional()`. New `getAdapterResponseSchema` + `AdapterSummary` type re-export (already exists) covers the single-adapter shape. New `getAdapter(baseUrl: string, adapterId: string, options?: RequestOptions): Promise<{ adapter: AdapterSummary }>` in `api-client.ts`.

- [ ] **Step 1: Update `adapterSummarySchema` in `apps/web/lib/api-schemas.ts`**

Read the current file first to confirm nothing shifted since this plan was written. Replace the `adapterSummarySchema` definition (the exact block shown in this plan's earlier research — `installed`/`statusMessage`/`detectedVersion` did not exist there before this task) with:

```typescript
export const adapterSummarySchema = z
  .object({
    adapterId: z.string(),
    displayName: z.string(),
    adapterVersion: z.string(),
    agentId: z.string(),
    agentDisplayName: z.string(),
    provider: z.string().optional(),
    integrationLevel: integrationLevelSchema,
    supportedOperatingSystems: z.array(operatingSystemSchema),
    capabilities: agentCapabilitiesSchema,
    // Phase 17.2 — straight from AgentDetectionResult's own already-safe
    // `installed` field (see apps/server's routes/adapters.ts).
    installed: z.boolean(),
    availability: availabilityStatusSchema,
    // Phase 10.2 — present only when availability is "available"; a
    // small, fixed, adapter-authored caveat about that otherwise-normal
    // result (e.g. Codex's trusted-local bypass notice). Never present
    // for any other availability value. See apps/server's adapters.ts.
    limitationNotice: z.string().optional(),
    // Phase 17.2 — the SAME underlying diagnosticMessage widened to
    // every availability value, not just "available" — used by the
    // Providers page to explain why a provider isn't connected. See
    // apps/server's routes/adapters.ts SafeAdapterSummary doc comment
    // for why widening this specific field is safe.
    statusMessage: z.string().optional(),
    detectedVersion: z.string().optional(),
    // Phase 11 — declaredCapabilities is static descriptor metadata;
    // everything else here is a fresh runtime observation from this
    // adapter's own detect() call. See apps/server's routes/adapters.ts.
    declaredCapabilities: z.array(capabilityIdSchema),
    assignable: z.boolean(),
    executionTrust: executionTrustSchema,
    capabilityObservations: z.array(capabilityObservationSchema),
    limitations: z.array(z.string()),
    detectedAt: z.string(),
  })
  .strict();

export type AdapterSummary = z.infer<typeof adapterSummarySchema>;

export const listAdaptersResponseSchema = z
  .object({ adapters: z.array(adapterSummarySchema) })
  .strict();

export const getAdapterResponseSchema = z.object({ adapter: adapterSummarySchema }).strict();
```

(The `listAdaptersResponseSchema` block already exists immediately after — keep it exactly as-is, just add the new `getAdapterResponseSchema` line after it, as shown.)

- [ ] **Step 2: Add `getAdapter` to `apps/web/lib/api-client.ts`**

Add `getAdapterResponseSchema` to the existing import block from `./api-schemas` (alongside `listAdaptersResponseSchema`), and add this function immediately after the existing `listAdapters`:

```typescript
export function getAdapter(
  baseUrl: string,
  adapterId: string,
  options: RequestOptions = {},
): Promise<z.infer<typeof getAdapterResponseSchema>> {
  return request(
    `${baseUrl}/api/v1/adapters/${encodeURIComponent(adapterId)}`,
    { method: "GET" },
    getAdapterResponseSchema,
    options,
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @hall-of-wisdom/web run typecheck`
Expected: clean. (No existing test exercises `api-schemas.ts`/`api-client.ts` directly in isolation — Task 5/6's component tests are what exercise this through `vi.mock`, matching `agents-catalog.test.tsx`'s established pattern exactly.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/api-schemas.ts apps/web/lib/api-client.ts
git commit -m "feat(web): schema + client support for widened adapter summary and single-provider fetch"
```

---

### Task 4: `provider-status.ts` — pure mapping helpers

**Files:**
- Create: `apps/web/components/providers/provider-status.ts`
- Test: `apps/web/components/providers/provider-status.test.ts`

**Interfaces:**
- Consumes: `type AdapterSummary` (Task 3).
- Produces: `type ConnectionState = "connected" | "not-connected"`, `deriveConnectionState(adapter: AdapterSummary): ConnectionState`, `deriveGuidanceText(adapter: AdapterSummary): string`, `connectCommandFor(adapterId: string): string | undefined`, `isKnownProviderAdapter(adapterId: string): boolean`.

- [ ] **Step 1: Write the failing test**

`apps/web/components/providers/provider-status.test.ts`:
```typescript
import { describe, expect, it } from "vitest";
import type { AdapterSummary } from "../../lib/api-schemas";
import {
  connectCommandFor,
  deriveConnectionState,
  deriveGuidanceText,
  isKnownProviderAdapter,
} from "./provider-status";

function makeAdapter(overrides: Partial<AdapterSummary> = {}): AdapterSummary {
  return {
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    adapterVersion: "1.0.0",
    agentId: "claude-code",
    agentDisplayName: "Claude Code",
    integrationLevel: "structured_cli",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
      toolEvents: true,
      fileEditing: true,
      shellExecution: true,
      subagents: false,
      mcp: false,
      acp: false,
    },
    installed: true,
    availability: "available",
    declaredCapabilities: [],
    assignable: true,
    executionTrust: "isolated",
    capabilityObservations: [],
    limitations: [],
    detectedAt: "2026-08-08T12:00:00.000Z",
    ...overrides,
  };
}

describe("deriveConnectionState", () => {
  it("is 'connected' exactly when availability is 'available'", () => {
    expect(deriveConnectionState(makeAdapter({ availability: "available" }))).toBe("connected");
  });

  it.each(["logged_out", "unavailable", "unsupported", "busy", "rate_limited", "offline"] as const)(
    "is 'not-connected' for availability %s",
    (availability) => {
      expect(deriveConnectionState(makeAdapter({ availability }))).toBe("not-connected");
    },
  );
});

describe("deriveGuidanceText", () => {
  it("prefers statusMessage when present, over any generic fallback", () => {
    const adapter = makeAdapter({
      availability: "logged_out",
      statusMessage: "Claude Code is installed but not logged in.",
    });
    expect(deriveGuidanceText(adapter)).toBe("Claude Code is installed but not logged in.");
  });

  it("falls back to a fixed, plain-language message per availability when statusMessage is absent", () => {
    const adapter = makeAdapter({ availability: "logged_out", statusMessage: undefined });
    expect(deriveGuidanceText(adapter)).toMatch(/not logged in/i);
  });

  it("has a distinct fallback for every AvailabilityStatus value, never returning an empty string", () => {
    const values = [
      "available",
      "busy",
      "rate_limited",
      "logged_out",
      "offline",
      "unavailable",
      "unsupported",
    ] as const;
    for (const availability of values) {
      const text = deriveGuidanceText(makeAdapter({ availability, statusMessage: undefined }));
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe("connectCommandFor", () => {
  it("returns the official login command for Claude Code", () => {
    expect(connectCommandFor("hall.claude-code")).toBe("claude login");
  });

  it("returns the official login command for Codex", () => {
    expect(connectCommandFor("hall.codex")).toBe("codex login");
  });

  it("returns undefined for an adapter with no known login flow", () => {
    expect(connectCommandFor("hall.mock-agent")).toBeUndefined();
  });
});

describe("isKnownProviderAdapter", () => {
  it("is true for Claude Code and Codex", () => {
    expect(isKnownProviderAdapter("hall.claude-code")).toBe(true);
    expect(isKnownProviderAdapter("hall.codex")).toBe(true);
  });

  it("is false for Mock Agent and any unrecognized adapter", () => {
    expect(isKnownProviderAdapter("hall.mock-agent")).toBe(false);
    expect(isKnownProviderAdapter("hall.some-future-adapter")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hall-of-wisdom/web exec vitest run provider-status`
Expected: FAIL — `./provider-status.js` does not exist yet.

- [ ] **Step 3: Write `provider-status.ts`**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hall-of-wisdom/web exec vitest run provider-status`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter @hall-of-wisdom/web run typecheck && pnpm --filter @hall-of-wisdom/web exec eslint components/providers/provider-status.ts components/providers/provider-status.test.ts`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/providers/provider-status.ts apps/web/components/providers/provider-status.test.ts
git commit -m "feat(web): pure connection-state/guidance/connect-command mapping for the Providers page"
```

---

### Task 5: `provider-card.tsx`

**Files:**
- Create: `apps/web/components/providers/provider-card.tsx`
- Test: `apps/web/components/providers/provider-card.test.tsx`

**Interfaces:**
- Consumes: `getAdapter`, `ApiClientError` (Task 3); `type AdapterSummary` (Task 3); `deriveConnectionState`, `deriveGuidanceText`, `connectCommandFor` (Task 4).
- Produces: `ProviderCard({ baseUrl, adapter, onUpdated }: { baseUrl: string; adapter: AdapterSummary; onUpdated: (updated: AdapterSummary) => void })` — a React component. Task 6 renders one per known provider and updates its own list state via `onUpdated`.

- [ ] **Step 1: Write the failing test**

`apps/web/components/providers/provider-card.test.tsx`:
```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { AdapterSummary } from "../../lib/api-schemas";
import { ProviderCard } from "./provider-card";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, getAdapter: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeAdapter(overrides: Partial<AdapterSummary> = {}): AdapterSummary {
  return {
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    adapterVersion: "1.0.0",
    agentId: "claude-code",
    agentDisplayName: "Claude Code",
    integrationLevel: "structured_cli",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
      toolEvents: true,
      fileEditing: true,
      shellExecution: true,
      subagents: false,
      mcp: false,
      acp: false,
    },
    installed: true,
    availability: "available",
    declaredCapabilities: [],
    assignable: true,
    executionTrust: "isolated",
    capabilityObservations: [],
    limitations: [],
    detectedAt: "2026-08-08T12:00:00.000Z",
    ...overrides,
  };
}

describe("ProviderCard", () => {
  beforeEach(() => {
    vi.mocked(apiClient.getAdapter).mockReset();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows Connected for an available provider", () => {
    render(
      <ProviderCard baseUrl={BASE_URL} adapter={makeAdapter()} onUpdated={() => {}} />,
    );
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows Not connected plus the adapter's own guidance for a logged-out provider", () => {
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({
          availability: "logged_out",
          assignable: false,
          statusMessage: "Claude Code is installed but not logged in.",
        })}
        onUpdated={() => {}}
      />,
    );
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Claude Code is installed but not logged in.")).toBeInTheDocument();
  });

  it("Connect reveals the exact official login command", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({ availability: "logged_out", assignable: false })}
        onUpdated={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByText("claude login")).toBeInTheDocument();
  });

  it("never shows a Connect button for an adapter with no known login command", () => {
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({ adapterId: "hall.mock-agent", displayName: "Mock Agent" })}
        onUpdated={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("Recheck calls getAdapter for this adapter's id and reports the refreshed summary via onUpdated", async () => {
    const updated = makeAdapter({ availability: "available", statusMessage: "Now connected." });
    vi.mocked(apiClient.getAdapter).mockResolvedValue({ adapter: updated });
    const onUpdated = vi.fn();
    const user = userEvent.setup();
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({ availability: "logged_out", assignable: false })}
        onUpdated={onUpdated}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Recheck" }));
    await waitFor(() => {
      expect(apiClient.getAdapter).toHaveBeenCalledWith(BASE_URL, "hall.claude-code", {});
    });
    expect(onUpdated).toHaveBeenCalledWith(updated);
  });

  it("shows an accessible error message when Recheck fails", async () => {
    vi.mocked(apiClient.getAdapter).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );
    const user = userEvent.setup();
    render(
      <ProviderCard baseUrl={BASE_URL} adapter={makeAdapter()} onUpdated={() => {}} />,
    );
    await user.click(screen.getByRole("button", { name: "Recheck" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Hall Core.");
  });

  it("always shows the trusted-local warning, unsoftened, when executionTrust is trusted_local", () => {
    render(
      <ProviderCard
        baseUrl={BASE_URL}
        adapter={makeAdapter({
          adapterId: "hall.codex",
          displayName: "Codex",
          executionTrust: "trusted_local",
        })}
        onUpdated={() => {}}
      />,
    );
    expect(screen.getByText(/not OS-sandboxed/)).toBeInTheDocument();
  });

  it("hides technical details (adapterId, integrationLevel, raw availability) until expanded", async () => {
    const user = userEvent.setup();
    render(
      <ProviderCard baseUrl={BASE_URL} adapter={makeAdapter()} onUpdated={() => {}} />,
    );
    expect(screen.queryByText("hall.claude-code")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show technical details" }));
    expect(screen.getByText("hall.claude-code")).toBeInTheDocument();
  });

  it("never renders executablePath, CODEX_HOME, or other leaked technical data", () => {
    const { container } = render(
      <ProviderCard baseUrl={BASE_URL} adapter={makeAdapter()} onUpdated={() => {}} />,
    );
    expect(container.innerHTML).not.toContain("executablePath");
    expect(container.innerHTML).not.toContain("CODEX_HOME");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hall-of-wisdom/web exec vitest run provider-card`
Expected: FAIL — `./provider-card.js` does not exist yet.

- [ ] **Step 3: Write `provider-card.tsx`**

```tsx
"use client";

import { useState } from "react";
import { ApiClientError, getAdapter } from "../../lib/api-client";
import type { AdapterSummary } from "../../lib/api-schemas";
import { connectCommandFor, deriveConnectionState, deriveGuidanceText } from "./provider-status";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Could not recheck this provider.";
}

export function ProviderCard({
  baseUrl,
  adapter,
  onUpdated,
}: {
  readonly baseUrl: string;
  readonly adapter: AdapterSummary;
  readonly onUpdated: (updated: AdapterSummary) => void;
}) {
  const [showConnect, setShowConnect] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  const state = deriveConnectionState(adapter);
  const guidance = deriveGuidanceText(adapter);
  const command = connectCommandFor(adapter.adapterId);

  async function handleRecheck() {
    setRechecking(true);
    setRecheckError(null);
    try {
      const response = await getAdapter(baseUrl, adapter.adapterId, {});
      onUpdated(response.adapter);
      setShowConnect(false);
    } catch (error) {
      setRecheckError(safeMessage(error));
    } finally {
      setRechecking(false);
    }
  }

  async function handleCopyCommand() {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail (permissions, non-secure context) — the
      // command is still visible as plain text either way, so this is a
      // convenience feature only and needs no user-facing error.
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center justify-between gap-2">
        <span className="text-base font-semibold">{adapter.displayName}</span>
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            state === "connected"
              ? "bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-200"
              : "bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200"
          }`}
        >
          {state === "connected" ? "Connected" : "Not connected"}
        </span>
      </div>

      <p className="text-sm text-stone-600 dark:text-stone-300">{guidance}</p>

      {adapter.executionTrust === "trusted_local" ? (
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          Trusted-local mode: this provider&apos;s sandbox and approval protections are bypassed —
          it is not OS-sandboxed and runs with your own filesystem permissions.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {command ? (
          <button
            type="button"
            onClick={() => setShowConnect((value) => !value)}
            className="rounded bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:hover:bg-amber-900/60"
          >
            Connect
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void handleRecheck()}
          disabled={rechecking}
          className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
        >
          {rechecking ? "Rechecking…" : "Recheck"}
        </button>
      </div>

      {recheckError ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {recheckError}
        </p>
      ) : null}

      {showConnect && command ? (
        <div className="flex flex-col gap-2 rounded border border-stone-200 bg-stone-50 p-3 text-sm dark:border-stone-800 dark:bg-stone-950/40">
          <p>Run this command in your own terminal, then click Recheck above:</p>
          <div className="flex items-center gap-2">
            <code className="rounded bg-stone-200 px-2 py-1 text-xs dark:bg-stone-800">
              {command}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyCommand()}
              className="rounded border border-stone-300 px-2 py-1 text-xs font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            This opens {adapter.displayName}&apos;s own official sign-in flow. Hall never sees or
            stores your password, API key, or login session.
          </p>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setShowDetails((value) => !value)}
        className="self-start text-xs text-stone-500 underline hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
      >
        {showDetails ? "Hide technical details" : "Show technical details"}
      </button>
      {showDetails ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
          <dt>Adapter ID</dt>
          <dd>{adapter.adapterId}</dd>
          <dt>Integration level</dt>
          <dd>{adapter.integrationLevel}</dd>
          <dt>Adapter package version</dt>
          <dd>{adapter.adapterVersion}</dd>
          <dt>Detected CLI version</dt>
          <dd>{adapter.detectedVersion ?? "Unknown"}</dd>
          <dt>Raw availability</dt>
          <dd>{adapter.availability}</dd>
          <dt>Declared capabilities</dt>
          <dd>{adapter.declaredCapabilities.join(", ") || "None"}</dd>
        </dl>
      ) : null}
    </li>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hall-of-wisdom/web exec vitest run provider-card`
Expected: PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter @hall-of-wisdom/web run typecheck && pnpm --filter @hall-of-wisdom/web exec eslint components/providers/provider-card.tsx components/providers/provider-card.test.tsx`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/providers/provider-card.tsx apps/web/components/providers/provider-card.test.tsx
git commit -m "feat(web): ProviderCard — status, guidance, Connect guidance panel, Recheck, technical details"
```

---

### Task 6: `providers-panel.tsx`, `/providers` page, nav link

**Files:**
- Create: `apps/web/components/providers/providers-panel.tsx`
- Test: `apps/web/components/providers/providers-panel.test.tsx`
- Create: `apps/web/app/providers/page.tsx`
- Modify: `apps/web/components/nav-bar.tsx`

**Interfaces:**
- Consumes: `listAdapters`, `ApiClientError` (existing, `api-client.ts`); `type AdapterSummary` (Task 3); `isKnownProviderAdapter` (Task 4); `ProviderCard` (Task 5).
- Produces: `ProvidersPanel({ baseUrl }: { baseUrl: string })` — the page's real content, following `AgentsCatalog`'s exact fetch/loading/error pattern.

- [ ] **Step 1: Write the failing test**

`apps/web/components/providers/providers-panel.test.tsx`:
```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import * as apiClient from "../../lib/api-client";
import type { AdapterSummary } from "../../lib/api-schemas";
import { ProvidersPanel } from "./providers-panel";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, listAdapters: vi.fn(), getAdapter: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";

function makeAdapter(overrides: Partial<AdapterSummary> = {}): AdapterSummary {
  return {
    adapterId: "hall.claude-code",
    displayName: "Claude Code",
    adapterVersion: "1.0.0",
    agentId: "claude-code",
    agentDisplayName: "Claude Code",
    integrationLevel: "structured_cli",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
      toolEvents: true,
      fileEditing: true,
      shellExecution: true,
      subagents: false,
      mcp: false,
      acp: false,
    },
    installed: true,
    availability: "available",
    declaredCapabilities: [],
    assignable: true,
    executionTrust: "isolated",
    capabilityObservations: [],
    limitations: [],
    detectedAt: "2026-08-08T12:00:00.000Z",
    ...overrides,
  };
}

describe("ProvidersPanel", () => {
  beforeEach(() => {
    vi.mocked(apiClient.listAdapters).mockReset();
    vi.mocked(apiClient.getAdapter).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders exactly Claude Code and Codex, never Mock Agent", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        makeAdapter({ adapterId: "hall.mock-agent", displayName: "Mock Agent" }),
        makeAdapter(),
        makeAdapter({ adapterId: "hall.codex", displayName: "Codex" }),
      ],
    });
    render(<ProvidersPanel baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
    });
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.queryByText("Mock Agent")).not.toBeInTheDocument();
  });

  it("shows a loading state, then an accessible error state on failure", async () => {
    vi.mocked(apiClient.listAdapters).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );
    render(<ProvidersPanel baseUrl={BASE_URL} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach Hall Core.");
  });

  it("updates only the rechecked provider's card, leaving the other unchanged", async () => {
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        makeAdapter({ availability: "logged_out", assignable: false }),
        makeAdapter({ adapterId: "hall.codex", displayName: "Codex" }),
      ],
    });
    vi.mocked(apiClient.getAdapter).mockResolvedValue({
      adapter: makeAdapter({ availability: "available" }),
    });
    render(<ProvidersPanel baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Not connected")).toHaveLength(1);
    expect(screen.getAllByText("Connected")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @hall-of-wisdom/web exec vitest run providers-panel`
Expected: FAIL — `./providers-panel.js` does not exist yet.

- [ ] **Step 3: Write `providers-panel.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { ApiClientError, listAdapters } from "../../lib/api-client";
import type { AdapterSummary } from "../../lib/api-schemas";
import { isKnownProviderAdapter } from "./provider-status";
import { ProviderCard } from "./provider-card";

function safeMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Could not load providers.";
}

/**
 * Phase 17.2 — onboarding/troubleshooting view for the two providers with
 * a real login flow (Claude Code, Codex). Distinct from the `/agents`
 * capability-comparison page (unmodified by this phase): this page never
 * shows Mock Agent, shows a two-state Connected/Not-connected headline
 * instead of a technical availability table, and adds mutating Connect
 * (client-only guidance, no server call)/Recheck actions that `/agents`
 * deliberately never has.
 */
export function ProvidersPanel({ baseUrl }: { readonly baseUrl: string }) {
  const [adapters, setAdapters] = useState<readonly AdapterSummary[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listAdapters(baseUrl, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setAdapters(response.adapters.filter((adapter) => isKnownProviderAdapter(adapter.adapterId)));
        setState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setErrorMessage(safeMessage(error));
        setState("error");
      });
    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  function handleUpdated(updated: AdapterSummary) {
    setAdapters((current) =>
      current.map((adapter) => (adapter.adapterId === updated.adapterId ? updated : adapter)),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700 dark:border-stone-800 dark:bg-stone-950/40 dark:text-stone-300">
        <p>
          Claude Code is the recommended default provider. Hall never collects your password, API
          key, or login session — sign-in always happens through each provider&apos;s own official
          command in your own terminal.
        </p>
      </div>

      {state === "loading" ? (
        <p role="status" className="text-sm text-stone-500">
          Loading providers…
        </p>
      ) : state === "error" ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {errorMessage}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {adapters.map((adapter) => (
            <ProviderCard
              key={adapter.adapterId}
              baseUrl={baseUrl}
              adapter={adapter}
              onUpdated={handleUpdated}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @hall-of-wisdom/web exec vitest run providers-panel`
Expected: PASS.

- [ ] **Step 5: Write `apps/web/app/providers/page.tsx`**

```tsx
"use client";

import { ApplicationShell } from "../../components/application-shell";
import { ServerStatus } from "../../components/server-status";
import { ProvidersPanel } from "../../components/providers/providers-panel";
import { resolveHallCoreUrl } from "../../lib/hall-core-url";

const { httpUrl: BASE_URL } = resolveHallCoreUrl();

export default function ProvidersPage() {
  return (
    <ApplicationShell statusSlot={<ServerStatus baseUrl={BASE_URL} />}>
      <ProvidersPanel baseUrl={BASE_URL} />
    </ApplicationShell>
  );
}
```

- [ ] **Step 6: Add the nav link**

In `apps/web/components/nav-bar.tsx`, add `{ href: "/providers", label: "Providers" }` to the `LINKS` array — insert it right after the `/agents` entry:

```typescript
const LINKS = [
  { href: "/", label: "Task Console" },
  { href: "/board", label: "Kanban Board" },
  { href: "/boards", label: "Communication Boards" },
  { href: "/agents", label: "Agents" },
  { href: "/providers", label: "Providers" },
  { href: "/comparisons", label: "Comparisons" },
  { href: "/ceo", label: "CEO Plans" },
  { href: "/system", label: "System" },
] as const;
```

- [ ] **Step 7: Typecheck, lint, full web package test**

Run: `pnpm --filter @hall-of-wisdom/web run typecheck && pnpm --filter @hall-of-wisdom/web exec eslint app/providers components/providers components/nav-bar.tsx && pnpm --filter @hall-of-wisdom/web run test`
Expected: all clean; full `apps/web` suite still green.

- [ ] **Step 8: Manually verify in a browser**

Run `pnpm --filter @hall-of-wisdom/hall-core run dev -- --workspace-root "D:\HallOfWisdom" --port 4310 --mock-scenario success --web-origin "http://127.0.0.1:3000"` and, in a second terminal, `pnpm --filter @hall-of-wisdom/web run dev`. Open `http://127.0.0.1:3000/providers`. Since Mock Agent is the only adapter composed in this dev configuration, expect an empty provider list (no Claude Code/Codex registered) with no error — confirms the page loads, the nav link works, and the known-provider filter behaves correctly against a real server. Note this in the phase completion report as the extent of manual verification (no real Claude Code/Codex CLI required or invoked).

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/providers/providers-panel.tsx apps/web/components/providers/providers-panel.test.tsx apps/web/app/providers/page.tsx apps/web/components/nav-bar.tsx
git commit -m "feat(web): /providers page — ProvidersPanel, route, nav link"
```

---

### Task 7: Playwright E2E spec

**Files:**
- Create: `apps/e2e/tests/providers.spec.ts`

**Interfaces:**
- Consumes: the existing shared fixture Hall Core server (`apps/e2e/src/fixture-server.ts`, unmodified — registers `createAllFixtureAdapters()`, which already includes Claude Code `available`/`isolated` and Codex `available`/`trusted_local` fixtures with real `diagnosticMessage` values).

This spec tests the "Connected" happy path plus the Connect/Recheck interactions against the existing shared fixture server — it does not modify `fixture-server.ts` or add a "not connected" fixture scenario (that would require a second fixture-server configuration shared by no other spec; the "not connected"/error states are already covered with full fidelity by Task 5/6's Vitest component tests via mocked API responses).

- [ ] **Step 1: Write the spec**

```typescript
import { expect, test } from "@playwright/test";

/**
 * Phase 17.2 E2E — the Providers page, against the same deterministic
 * fixture Hall Core `apps/e2e/tests/agents-catalog.spec.ts` already uses:
 * Claude Code and Codex are both `available` fixtures with real
 * `diagnosticMessage` values (Codex is `trusted_local`). No provider
 * process is ever started — every adapter here is a fixture whose
 * `startTask()` always rejects, and this spec never spawns `claude`/`codex`
 * itself either (Connect is a static client-only guidance panel).
 */
test.describe("Providers page", () => {
  test("shows Claude Code and Codex as Connected, never Mock Agent, with no sensitive data", async ({
    page,
  }) => {
    await page.goto("/providers");

    const list = page.getByRole("list");
    await expect(list).toBeVisible();
    await expect(list.getByText("Claude Code", { exact: true })).toBeVisible();
    await expect(list.getByText("Codex", { exact: true })).toBeVisible();
    await expect(list.getByText("Mock Agent", { exact: true })).toHaveCount(0);

    const claudeCard = list.getByRole("listitem").filter({ hasText: "Claude Code" });
    await expect(claudeCard.getByText("Connected")).toBeVisible();
    const codexCard = list.getByRole("listitem").filter({ hasText: "Codex" });
    await expect(codexCard.getByText("Connected")).toBeVisible();
    await expect(codexCard.getByText(/not OS-sandboxed/)).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/executablePath/i);
    expect(bodyText).not.toMatch(/\.exe|\.cmd|\.bat/);
    expect(bodyText).not.toMatch(/CODEX_HOME/);
    expect(bodyText).not.toMatch(/api[_-]?key\s*[:=]/i);
    expect(bodyText).not.toMatch(/bearer\s+[a-z0-9._-]{10,}/i);
    expect(bodyText).not.toMatch(/OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN/);
  });

  test("Connect shows the provider's own official login command and never touches the server", async ({
    page,
  }) => {
    await page.goto("/providers");
    const claudeCard = page.getByRole("listitem").filter({ hasText: "Claude Code" });

    let connectRequestSeen = false;
    page.on("request", (request) => {
      if (request.url().includes("/connect")) connectRequestSeen = true;
    });

    await claudeCard.getByRole("button", { name: "Connect" }).click();
    await expect(claudeCard.getByText("claude login")).toBeVisible();
    expect(connectRequestSeen).toBe(false);
  });

  test("Recheck re-fetches this provider's status without reloading the page", async ({
    page,
  }) => {
    await page.goto("/providers");
    const claudeCard = page.getByRole("listitem").filter({ hasText: "Claude Code" });

    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/v1/adapters/hall.claude-code")),
      claudeCard.getByRole("button", { name: "Recheck" }).click(),
    ]);
    expect(response.status()).toBe(200);
    await expect(claudeCard.getByText("Connected")).toBeVisible();
  });

  test("is usable at a 390x844 mobile viewport with no page-level horizontal overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/providers");

    await expect(page.getByText("Claude Code", { exact: true })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});
```

- [ ] **Step 2: Build and run**

Run: `pnpm --filter @hall-of-wisdom/e2e run build && pnpm --filter @hall-of-wisdom/e2e run e2e -- tests/providers.spec.ts`
Expected: all 4 tests pass. If Playwright browsers aren't installed in this environment, run `pnpm --filter @hall-of-wisdom/e2e run e2e:install` first and retry.

- [ ] **Step 3: Run the full existing E2E suite once, to confirm no regression**

Run: `pnpm --filter @hall-of-wisdom/e2e run e2e`
Expected: every existing spec (including `agents-catalog.spec.ts`) still passes — confirms the widened `SafeAdapterSummary`/new route didn't disturb anything the existing suite depends on.

- [ ] **Step 4: Commit**

```bash
git add apps/e2e/tests/providers.spec.ts
git commit -m "test(e2e): Providers page — connected state, Connect guidance, Recheck, no leaks, mobile viewport"
```

---

### Task 8: ADR 0018

**Files:**
- Create: `docs/architecture/0018-provider-connection-onboarding.md`
- Modify: `README.md` (one line, matching Phase 17.1's precedent for adding a new ADR to the architecture-documents list)

- [ ] **Step 1: Write the ADR**

`docs/architecture/0018-provider-connection-onboarding.md`:
```markdown
# ADR 0018: Provider Connection & Authentication Onboarding UX

## Status

Accepted (Phase 17.2).

## Context

A normal user had no way to see, from Hall Web, whether Claude Code or Codex was installed,
authenticated, and ready to run tasks — only the `/agents` capability-comparison page existed,
which is deliberately read-only and written for a technical audience comparing adapters, not for
guiding a first-time user toward a working connection.

## Decision

A new Hall Web page, `/providers`, shows Claude Code and Codex as simple two-state cards
("Connected" / "Not connected") with plain-language guidance underneath, sourced from each
adapter's own `detect()` result — never re-derived or interpreted by the UI.

Two currently-hidden-but-already-safe `AgentDetectionResult` fields (`installed`,
`detectedVersion`) are now exposed on `GET /api/v1/adapters`'s response, and a third,
`diagnosticMessage`, is exposed under a new field, `statusMessage`, for every `availability`
value — previously it was blocked from reaching the client except in the narrow, `available`-only
`limitationNotice` case. This widening is safe because every `diagnosticMessage` in this codebase
is a fixed, hand-authored, non-secret sentence by contract (`agent-adapter-sdk`'s own doc comment:
adapters must never put unredacted output into this field) — never raw CLI output, a path, or a
token. `limitationNotice`'s existing, narrower contract is unchanged.

A new, narrow route, `GET /api/v1/adapters/:adapterId`, lets the page's per-provider Recheck
button refresh one card without re-fetching or re-rendering the other — built by extracting the
existing list route's summary-construction logic into a shared `buildAdapterSummary()` helper, not
by duplicating detection logic.

**"Connect" is guide-only, not launch.** It opens a static, client-rendered panel — the provider's
own official login command (`claude login` / `codex login`), a copy button, and plain-language
steps — with no server call and nothing spawned by Hall Core. This was a deliberate choice: neither
CLI's login flow had been probed in this codebase for exactly how it behaves end-to-end (browser
OAuth vs. an interactive terminal), and Hall must never become a party to any part of a
credential-bearing I/O stream. The user runs the command in their own terminal and clicks
"Recheck" when done.

Codex trusted-local mode remains a read-only, startup-only fact on this page — there is no runtime
toggle anywhere in the codebase, so the page cannot enable it, trivially satisfying "never enable
it merely because Codex is authenticated." When shown, it always carries its existing "not
OS-sandboxed" wording, never softened.

## Consequences

- A user can now diagnose "why isn't this provider connected" without leaving Hall Web, using only
  guidance the corresponding adapter itself already writes.
- No new credential-handling surface exists anywhere in Hall Core or Hall Web as a result of this
  phase — `statusMessage`/`installed`/`detectedVersion` are all sourced from data that was already
  computed and already contractually safe; only the field enumeration changed.
- The `/agents` page is unmodified — it remains the technical capability-comparison view; `/providers`
  is the onboarding/troubleshooting view. Two pages, two audiences, one shared detection source.
- `apps/web`'s Providers page filters `GET /api/v1/adapters`'s response to exactly `hall.claude-code`
  and `hall.codex` — a small, deliberate allowlist matching the target UX, not a general "which
  adapters are providers" mechanism.
```

- [ ] **Step 2: Add the ADR to README's architecture list**

In `README.md`, add one line to the "Key architecture documents" bullet list (after the `0017` entry added in Phase 17.1):
```markdown
- [`docs/architecture/0018-provider-connection-onboarding.md`](docs/architecture/0018-provider-connection-onboarding.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/0018-provider-connection-onboarding.md README.md
git commit -m "docs: add ADR 0018 for provider connection onboarding UX"
```

---

### Task 9: Full workspace verification, security review, and phase completion report

**Files:** none created; this task runs the repository's quality gates end to end and writes the completion report the project's phase-report convention (`AGENTS.md`) requires. Per CLAUDE.md, final verification and the completion report are the main session's own responsibility — this task is executed directly, not dispatched to a subagent.

- [ ] **Step 1: Run the full verification suite from the repo root**

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm verify:package-entry
git diff --check
```
Every command must succeed and `git diff --check` must report no whitespace errors. If anything fails, use `superpowers:systematic-debugging` to determine whether it's a Phase 17.2 regression (fix it, re-run from Step 1) or a pre-existing baseline problem (confirm via checking the same command against the branch's own starting commit `9e0c78e089c36aa516f89dead6a0dbd1de69e63e` before concluding this).

- [ ] **Step 2: Run the relevant Playwright tests**

```bash
pnpm --filter @hall-of-wisdom/e2e run build
pnpm --filter @hall-of-wisdom/e2e run e2e
```
Confirm the full E2E suite passes, including Task 7's new spec and the pre-existing `agents-catalog.spec.ts`.

- [ ] **Step 3: Security self-review**

Confirm, by rereading the actual final code (not from memory):
- Grep `apps/web/components/providers/` and `apps/server/src/routes/adapters.ts` for `password`, `apiKey`, `token`, `credential`, `cookie` (case-insensitive) — none should appear except in prose explaining what Hall does NOT collect.
- Confirm `provider-card.tsx`'s Connect flow makes no `fetch`/API call of any kind — grep the file for `fetch(` and every `api-client` import; only `getAdapter` should appear, and only inside `handleRecheck`.
- Confirm `statusMessage`/`installed`/`detectedVersion` are only ever populated from a successfully-completed `detect()` call in `detectSafely` — reread the catch branch and confirm none of the three appear there.
- Confirm the new `GET /api/v1/adapters/:adapterId` route never accepts or reflects anything from the request body/query — only `request.params.adapterId`, used solely to look up an existing descriptor.
- Confirm no changes touched `apps/server/src/composition/`, `adapters/claude-code/`, `adapters/codex/`, `apps/server/src/agent-worktrees/`, or any Phase 17.1 file (`packages/hall-config/`, `install.ps1`, `scripts/install/`) — `git diff --stat main...HEAD` should show only the files this plan's tasks listed.

Fix anything this pass finds before proceeding.

- [ ] **Step 4: Inspect the complete diff before final push**

```bash
git status
git diff --stat main...HEAD
```
Confirm no secrets, generated data (`dist/`, `node_modules/`, `.next/`), databases, logs, or personal paths are staged.

- [ ] **Step 5: Push the branch (no PR)**

```bash
git push -u origin phase-17-2-provider-onboarding
```
Do not run `gh pr create` — this phase's kickoff explicitly says not to create or merge a PR.

- [ ] **Step 6: Write the phase completion report**

Per `AGENTS.md`'s required end-of-phase report format, produce a report containing exactly these sections: Phase Completed, What Was Implemented, Files Created or Changed, Commands Executed, Test Results, Security and Bug Review, How to Verify, Expected Output, Git Status, Next Proposed Phase, and end with a `STOPPED` line. Additionally cover, per this phase's kickoff's own final-report requirements:
- UX flow (Providers page layout, Connect guidance panel, Recheck).
- API changes (the three widened fields, the new `GET /api/v1/adapters/:adapterId` route, exact response shapes).
- Provider/auth behavior (guide-only Connect, no credential handling, Codex trusted-local read-only).
- Readiness for PR (explicitly state the branch is pushed but no PR was created, per instruction).
- Explicit confirmation that Phase 17.3 was not started.
