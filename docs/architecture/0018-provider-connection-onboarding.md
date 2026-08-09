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
token. `limitationNotice`'s existing, narrower contract is unchanged. `installed` is a plain
boolean with no such nuance. `detectedVersion` is the one exception worth naming explicitly: it
*is* raw CLI stdout (each adapter's own `--version` output, first line, trimmed and capped at 64
characters) rather than a hand-authored string — bounded and incapable of carrying a credential,
but not "already contractually safe" in the same sense as the other two fields, so it deserves
scrutiny if any adapter's version-string format ever changes.

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
