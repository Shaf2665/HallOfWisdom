# 0002 — Agent Adapter Boundary

Status: Draft (Phase 3).

## Context

Phase 3 introduces the first two real packages beyond the protocol: `@hall-of-wisdom/agent-adapter-sdk`
(the contract every coding-agent integration implements) and `@hall-of-wisdom/mock-agent` (the
first concrete adapter, deterministic and network-free). This document records the boundary
decisions made while building them, so later adapters (Claude Code, Codex, ...) and Hall Runner
follow the same rules instead of each reinventing them.

## Dependency direction

```text
@hall-of-wisdom/protocol
             ^
@hall-of-wisdom/agent-adapter-sdk
             ^
@hall-of-wisdom/mock-agent
```

`protocol` depends on nothing else in this workspace. `agent-adapter-sdk` depends only on
`protocol`. `mock-agent` depends on both. This is enforced by what each package's `package.json`
actually declares as a `workspace:*` dependency — there is no additional tooling gate yet, but the
direction is a hard rule for every future adapter too.

## Why adapters are separate from Hall Runner

Adapter-specific code (Mock Agent today; Claude Code and Codex later) lives in its own
`adapters/<name>` package, not inside Hall Runner. Hall Runner's job (starting in Phase 4) is to
discover, start, cancel, and stream events from _whatever_ adapters are installed — it should
depend on the `AgentAdapter` interface, never on a concrete adapter's internals. Keeping adapters
as separate packages makes this enforceable structurally: Hall Runner can only ever import the SDK
interface and construct adapters through it, the same way any adapter would be constructed by any
future orchestrator (a test harness, a CLI, a different runner implementation).

## Why the SDK depends only on the protocol

`agent-adapter-sdk` defines _shapes_ (descriptor, detection result, task input) and _mechanisms_
(event factory, terminal-event guard, typed errors) that any adapter needs, regardless of which
agent it wraps. None of that requires knowing about Hall Runner, Git, a specific provider, or a
specific agent's CLI. Depending on nothing but `protocol` keeps the SDK usable in contexts this
phase hasn't built yet — a browser-based adapter test harness, for instance — without dragging in
Node-runner-specific or Git-specific code it doesn't need.

## Why provider-specific events cannot escape adapters

Every event an adapter emits is constructed through `EventFactory`, which only knows how to build
the nine `NormalizedAgentEvent` variants defined in `@hall-of-wisdom/protocol`. There is no
mechanism in the SDK for an adapter to emit an arbitrary, adapter-defined event shape — the type
system only offers `EventFactory`'s fixed set of methods (`runStarted`, `messageDelta`,
`toolStarted`, ..., `runCancelled`). A future Claude Code or Codex adapter that wants to expose
something specific to its own agent (e.g. a Claude-specific "thinking" event) must translate it
into one of these nine shapes — most naturally `message.delta` or `tool.started`/`tool.completed`
— before it can leave the adapter. This is the same "provider-neutral core" constraint from
`0001-initial-architecture.md`, now given an actual enforcement mechanism instead of being only a
stated rule.

## Why `AsyncIterable` for event streaming

`AgentRunHandle.events` is an `AsyncIterable<NormalizedAgentEvent>`, not a callback
(`onEvent(cb)`) or an event emitter. Reasons:

- **Natural backpressure.** A consumer that is slower than the producer (e.g. writing events to a
  database one at a time) simply doesn't call `next()` again until it's ready; a callback-based
  push API has no equivalent without a manual queue.
- **Composable with `for await`.** Hall Core will eventually need to consume these events and
  forward them over a WebSocket; `for await (const event of run.events)` is the direct, idiomatic
  way to do that without inventing a subscription/unsubscription protocol.
- **One iteration is one execution.** Because the Mock Agent's generator is lazy, "consuming the
  stream" and "running the task" are the same act, which keeps the mental model simple: there is
  no separate "start" call that races against "start listening".

The tradeoff, made explicit rather than hidden: only one iteration meaningfully drives execution.
`AgentRunHandle.completion` resolves as a side effect of `events` being iterated to its terminal
event, not independently. An adapter (or Hall Runner, later) that wants multiple independent
consumers of the same run's events would need to fan the stream out itself; the SDK does not do
this for you in Phase 3, since nothing in this phase's scope needs it yet.

## Cancellation behavior

Two cancellation paths exist and are unified internally by every implementation (see
`MockAgentRun`):

- **Explicit**: `AgentRunHandle.cancel(reason?)`, called by whoever holds the handle.
- **Hall-provided**: an `AbortSignal` passed via `AgentExecutionOptions.signal` into `startTask`,
  representing infrastructure-level cancellation (a timeout, a process shutdown) rather than a
  specific human or orchestrator decision.

In the Mock Agent's implementation, an explicit `cancel()` call records `cancelledBy: "orchestrator"`
(the caller holding the handle — normally Hall Runner, acting on the orchestrator's behalf); an
externally-supplied `AbortSignal` firing records `cancelledBy: "system"`. This mapping is a Mock
Agent (and, by convention, expected-adapter) policy, not something the SDK enforces structurally —
the SDK's `runCancelled` event factory method accepts any valid `CancelledBy` value and leaves the
choice to the caller.

Cancellation is idempotent by construction, not by special-casing: the first successful call wins
(tracked by a single boolean flag before the shared `AbortController` is ever aborted), and every
attempt to actually emit a `run.cancelled` event goes through the same `TerminalEventGuard` every
other event does. A second attempt — whether from a second `cancel()` call, a racing `AbortSignal`,
or a cancellation arriving after the run already completed or failed — throws
`EventAfterTerminationError` internally, which the adapter catches and treats as a no-op. See
`TerminalEventGuard`'s own documentation for why a single throw-based rule was chosen over ad hoc
per-combination handling.

**Immediate abort** (the signal is already aborted before the run's first step executes): no
`run.started` is emitted; exactly one `run.cancelled` is emitted instead. This is the SDK spec's
suggested default, adopted as-is: a run that Hall Runner decided to cancel before it ever began
should not appear to have started at all.

## Terminal-event guarantees

`TerminalEventGuard` (in `@hall-of-wisdom/agent-adapter-sdk`) enforces exactly one rule: **the
first terminal event (`run.completed`, `run.failed`, or `run.cancelled`) wins; every event
submitted after it — terminal or not — throws.** This single rule is deliberately chosen over one
case per terminal-vs-terminal combination, because every individual guarantee the SDK needs
("completion cannot be replaced by cancellation", "cancellation cannot be replaced by failure",
etc.) is a corollary of it. The policy is throw, not silently ignore, because a duplicate or late
event usually signals a real bug in the adapter driving the guard; a caller that has a _legitimate_
reason to attempt a redundant terminal transition (idempotent cancellation) is expected to catch
`EventAfterTerminationError` at that specific call site, as `MockAgentRun` does.

## Event sequence ownership

`EventFactory` owns the `sequence` counter for exactly one run: one factory instance is created per
run (see `MockAgentRun`'s constructor), starts at 0, and increments by exactly 1 per event
produced by that instance. Sequence numbers are never shared across two runs and are never reset
mid-run. Ordering and deduplication _across_ reconnects is a Hall Core concern (per
`0001-initial-architecture.md`) — the factory's only job is to guarantee the numbers themselves are
correct and monotonic at the source.

## Where path validation will occur later

`AgentTaskInput.workingDirectory` is an unvalidated, bounded string in this SDK. Neither the SDK
nor the Mock Agent checks that it exists, is absolute, or is safe from path traversal. That
validation is now implemented in Hall Runner (Phase 4), performed once before any adapter is
invoked — not duplicated (or forgotten) inside every adapter's own code. See
[`0003-hall-runner-boundary.md`](0003-hall-runner-boundary.md) for the implementation.

## Where credential handling and redaction will occur later

Nothing in this phase reads, stores, or transmits credentials. `AgentDetectionResult` and
`AgentTaskInput` are structurally incapable of carrying them (no such fields exist, and both
schemas are `.strict()`). The still-open gap, carried over from Phase 2.1's note on
`StructuredFailure.details` in `0001-initial-architecture.md`: bounded shape does not guarantee an
adapter's captured output is free of secrets. A dedicated redaction layer — applied by real adapters and Hall Runner before
constructing any protocol object from captured process output — remains unbuilt and is now also a
concern for future adapters' `detect()` results (`diagnosticMessage`) and any future failure
payloads they construct, not just `StructuredFailure`.
