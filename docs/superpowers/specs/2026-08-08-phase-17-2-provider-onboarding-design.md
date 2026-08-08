# Phase 17.2 — Provider Connection & Authentication UX — Design

Status: Approved for implementation planning.
Date: 2026-08-08
Starting commit: `9e0c78e089c36aa516f89dead6a0dbd1de69e63e` (origin/main, working tree clean)

## 1. Problem

A normal user has no way to see, from Hall Web, whether Claude Code or Codex is installed,
authenticated, and ready to run tasks — they have to figure out CLI login flows themselves with
no in-app guidance. Phase 17.2 adds a Providers/Connections screen that surfaces this status in
plain language and guides the user toward the provider's own official login command, without Hall
ever touching a credential.

## 2. What already exists (reused as-is, never duplicated)

- **`AgentAdapter.detect()`** (`packages/agent-adapter-sdk/src/adapter.ts`) is the single, existing,
  first-class "check readiness" method every adapter (Mock, Claude Code, Codex) already implements.
  Claude Code's and Codex's implementations already do exactly the credential-safe detection this
  phase needs: bounded `--version`/`--help` spawns, a narrow `auth status`/`login status` classifier
  that reduces raw CLI output to a small safe struct and never lets it escape the classifier
  function, and a fixed set of pre-written, safe, user-facing diagnostic strings for every failure
  mode (CLI missing, CLI outdated, logged out, authenticated-but-unsupported, trusted-local
  preconditions unmet, etc.).
- **`GET /api/v1/adapters`** (`apps/server/src/routes/adapters.ts`) already calls `detect()` across
  every registered adapter through a fail-safe `detectSafely()` wrapper and returns a
  `SafeAdapterSummary` per adapter: `installed`, `availability` (7-value enum incl. `available` /
  `logged_out` / `unsupported` / `unavailable`), `executionTrust` (`isolated` / `trusted_local` /
  `unavailable`), `diagnosticMessage`, `limitations`, `capabilityObservations`, `detectedVersion`.
  This endpoint is provider-neutral and already powers the existing `/agents` catalog page.
- **`/agents` catalog** (`apps/web/app/agents/page.tsx` + `apps/web/components/agents/agents-catalog.tsx`)
  is a read-only capability-comparison table over the same data. Its own doc comments describe it as
  never letting an operator assign/start anything from there — a different purpose (technical
  comparison) from this phase's onboarding/troubleshooting screen for non-technical users. Not
  modified by this phase.
- **`--enable-codex-trusted-local`** is a Hall Core startup-only CLI flag with no runtime toggle
  anywhere in the codebase — confirmed via the `.strict()` schema rejection already in place. When
  it's off, Codex's `detect()` already fails closed with a specific, safe diagnostic message; this
  phase's UI only ever displays that message, never interprets or overrides the trust decision.

## 3. Decision: "Connect" is guide-only, not launch

`--verify-only`-style spawning of `claude login` / `codex login` was considered and rejected for
this phase: neither CLI's login flow has been probed in this codebase for exactly how it behaves
end-to-end (browser-based device code vs. requiring the calling terminal to stay interactive), and
Hall must never become a party to any part of a credential-bearing I/O stream. Guide-only has zero
new server-side process-spawning surface: **"Connect" opens a static, non-sensitive guidance panel**
(the exact command, a copy button, 2-3 plain-language steps, "then click Recheck") entirely
rendered client-side, with no server round-trip. This is the only credential-related behavioral
change this phase makes to the runtime — everything else is read-only status display.

## 4. New Hall Web page: `/providers`

New route (`apps/web/app/providers/page.tsx`, thin wrapper matching the existing `page.tsx`
convention) + new component tree under `apps/web/components/providers/`. Added to `NavBar`'s link
list. Not an extension of `/agents` — different audience (non-technical), different purpose
(connection health + guided remediation vs. capability comparison), different actions (mutating
Connect/Recheck vs. strictly read-only).

Each provider (Claude Code, Codex) renders as a card:
- **Headline: exactly two plain-language states** — "Connected" (`availability === "available"`) or
  "Not connected" (everything else) — matching the target UX exactly.
- **Guidance line** underneath, explaining why when not connected. Sourced verbatim from the
  adapter's own `diagnosticMessage`/`limitations` fields wherever present (already safe, bounded,
  pre-written for exactly this purpose); a small set of UI-level fallback strings cover the cases
  where those fields are absent (e.g. `installed: false` → "Claude Code CLI not found — install it
  from the official docs"). The UI performs no detection-logic interpretation of its own — it only
  ever displays fields the server already computed.
- **Execution/trust mode**, shown in the main view (not hidden behind details) because it's
  safety-relevant: Codex's `trusted_local` badge is never softened, always paired with its "not
  OS-sandboxed" wording, mirroring the existing `TrustBadge` component's established behavior.
- **Connect** button → the guidance panel described in §3.
- **Recheck** button → re-fetches that one provider's status (see §5) and updates just that card,
  with a per-card loading state.
- **Collapsible "Show technical details"** — adapter ID, integration level, declared capabilities,
  detected version, raw availability enum value. Everything CLI-argument-shaped or
  internal-adapter-terminology-shaped lives here, never in the primary view, per requirement 11.

Detection error handling: a per-adapter `detect()` throw is already caught safely server-side by the
existing `detectSafely()` wrapper (never reaches the client as a crash); a page-level fetch failure
(network/server error) is handled the same way `AgentsCatalog` already handles it today (a distinct
error state, no silent blank screen). "Login cancelled/failed" has no direct server signal under the
guide-only design (Hall never launches anything, so it cannot distinguish "never tried" from "tried
and cancelled") — the guidance text for the not-connected state covers this by suggesting the user
re-run the command and check their own terminal for errors.

## 5. New API surface

- **Reused as-is:** `GET /api/v1/adapters` — initial page load for both providers.
- **New, narrow:** `GET /api/v1/adapters/:adapterId` — added to the existing
  `apps/server/src/routes/adapters.ts`, reusing its existing `detectSafely()`/summary-building
  helpers for a single adapter ID instead of looping over the registry. Returns 404 for an unknown
  ID. Powers the per-provider Recheck button without needing to re-fetch or re-render the other
  provider's card. No new detection logic — the only new code is the route handler and its
  single-ID plumbing through helpers that already exist.
- **No endpoint added for Connect** — per §3, it is fully client-rendered static content.

## 6. Explicitly out of scope for this phase

No credential collection of any kind. No reading of `.claude`/`.codex` config or auth file contents
(existence-only checks, where they already exist, are untouched — this phase adds none of its own).
No proxying of any login I/O through Hall Web. No persisted "connection status" — per the
requirement, every render is a fresh `detect()` call; nothing about auth state is treated as durable
truth. No strict-Codex sandbox work (remains fail-closed/deferred, unchanged). No runtime toggle for
Codex trusted-local. No changes to `/agents`, the Kanban board, or any other existing Hall Web page.
No Phase 17.3 (launcher) work.

## 7. Tests

- **Server**: extend `apps/server/src/routes/adapters.test.ts` for the new per-adapter route — known
  adapter ID returns its `SafeAdapterSummary`, unknown ID returns 404, a `detect()` throw is handled
  the same safe way the existing full-list route already handles it, no leaked fields
  (`executablePath`, `CODEX_HOME`, raw auth tokens) — mirroring the existing route's test
  conventions (Fastify `inject`, fake adapters, no real CLI ever spawned).
- **Web**: new component test(s) under `apps/web/components/providers/`, shaped like the existing
  `agents-catalog.test.tsx` (renders every adapter, Connected/Not-connected mapping is correct,
  trusted-local badge never softened, Connect shows the exact login command with a working copy
  affordance, Recheck triggers exactly one re-fetch for the right adapter and updates only that
  card, technical details are hidden until expanded, no leaked technical fields in the default
  view).
- **E2E**: new Playwright spec under `apps/e2e/tests/`, mirroring `agents-catalog.spec.ts` — same
  fixture-adapter pattern (`apps/e2e/src/fixture-adapters.ts`, no real Claude Code/Codex process
  ever started), asserting the page renders both providers, Connect opens the guidance panel with
  the correct command text, Recheck refetches, plus the same no-leak regex battery this project
  already applies to `/agents` (`executablePath`, `.exe`/`.cmd`/`.bat`, `CODEX_HOME`, API-key/bearer
  patterns, `OPENAI_API_KEY`/`CODEX_API_KEY`/`CODEX_ACCESS_TOKEN`) and a mobile-viewport
  (390×844) overflow check.

## 8. Documentation

A short ADR (`docs/architecture/0018-provider-connection-onboarding.md`) documenting the guide-only
`Connect` decision and its security rationale (§3), and the new narrow endpoint (§5) — proportionate
to the scope of this phase, matching the project's existing per-phase ADR convention.
