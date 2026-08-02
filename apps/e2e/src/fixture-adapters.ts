import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseAgentAdapterDescriptor,
  type AgentAdapter,
  type AgentAdapterDescriptor,
  type AgentDetectionResult,
  type AgentRunHandle,
  type AgentTaskInput,
  type RunTerminalState,
} from "@hall-of-wisdom/agent-adapter-sdk";
import type { CapabilityObservation, NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { MockAgentAdapter, type MockAgentScenario } from "@hall-of-wisdom/mock-agent";

/**
 * Deterministic, fixture `AgentAdapter` implementations for Playwright
 * E2E verification only — never used by any production composition path
 * (`server.ts`/`server-composition.ts` never import this module). Every
 * `detect()` result below is fixed and immediate: no real `claude`/`codex`
 * process is ever spawned, and no subscription usage is ever spent. Every
 * `startTask()` rejects — this fixture set exists to verify the
 * capability/trust/routing/assignment *UI and API surface*, not to run a
 * real or simulated task; the Playwright suite never clicks "Start".
 *
 * The fixed detection results below intentionally mirror the exact
 * "CURRENT VERIFIED ADAPTER STATE" shape real adapters report on a
 * correctly configured machine (see
 * `docs/architecture/0011-agent-capabilities-trust-and-routing.md`), so
 * the E2E suite exercises genuinely representative data, not arbitrary
 * placeholder values.
 */

const IMPLEMENTATION_CAPABILITIES: readonly CapabilityObservation[] = [
  {
    capability: "project.read",
    status: "verified",
    safeSummary: "Verified by a Phase 11 E2E fixture.",
    evidence: "deterministic_test",
  },
  {
    capability: "project.edit",
    status: "verified",
    safeSummary: "Verified by a Phase 11 E2E fixture.",
    evidence: "deterministic_test",
  },
  {
    capability: "structured.events",
    status: "verified",
    safeSummary: "Verified by a Phase 11 E2E fixture.",
    evidence: "deterministic_test",
  },
  {
    capability: "cancellation",
    status: "verified",
    safeSummary: "Verified by a Phase 11 E2E fixture.",
    evidence: "deterministic_test",
  },
];

function buildDescriptor(
  adapterId: string,
  displayName: string,
  agentId: string,
): AgentAdapterDescriptor {
  return {
    adapterId,
    displayName,
    adapterVersion: "0.0.0-e2e-fixture",
    integrationLevel: adapterId === "hall.mock-agent" ? "native" : "structured_cli",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    supportedAgent: {
      agentId,
      displayName,
      adapterId,
      adapterVersion: "0.0.0-e2e-fixture",
    },
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
      toolEvents: true,
      fileEditing: adapterId !== "hall.mock-agent",
      shellExecution: adapterId !== "hall.mock-agent",
      subagents: false,
      mcp: false,
      acp: false,
    },
    declaredCapabilities:
      adapterId === "hall.mock-agent"
        ? ["structured.events", "cancellation"]
        : [
            "project.read",
            "project.edit",
            "command.execute",
            "git.inspect",
            "structured.events",
            "cancellation",
          ],
  };
}

function buildFixtureAdapter(
  descriptor: AgentAdapterDescriptor,
  detection: AgentDetectionResult,
): AgentAdapter {
  return {
    descriptor,
    detect(): Promise<AgentDetectionResult> {
      return Promise.resolve(detection);
    },
    startTask(): Promise<never> {
      return Promise.reject(
        new Error(
          `${descriptor.adapterId}.startTask must never be called — this is a Phase 11 E2E fixture, not a real adapter.`,
        ),
      );
    },
  };
}

export function createFixtureMockAgentAdapter(): AgentAdapter {
  return buildFixtureAdapter(buildDescriptor("hall.mock-agent", "Mock Agent", "mock-agent"), {
    installed: true,
    availability: "available",
    executionTrust: "simulated",
    capabilityObservations: [
      {
        capability: "structured.events",
        status: "verified",
        safeSummary: "Verified by a Phase 11 E2E fixture.",
        evidence: "deterministic_test",
      },
      {
        capability: "cancellation",
        status: "verified",
        safeSummary: "Verified by a Phase 11 E2E fixture.",
        evidence: "deterministic_test",
      },
    ],
    limitations: ["Simulated execution only — no real filesystem or process changes."],
  });
}

export function createFixtureClaudeCodeAdapter(): AgentAdapter {
  return buildFixtureAdapter(buildDescriptor("hall.claude-code", "Claude Code", "claude-code"), {
    installed: true,
    availability: "available",
    executionTrust: "isolated",
    capabilityObservations: [...IMPLEMENTATION_CAPABILITIES],
    limitations: [
      "Runs in this adapter's fixed --safe-mode profile; no discretionary --setting-sources are passed.",
    ],
    diagnosticMessage: "Claude Code is installed and authenticated with a Claude subscription.",
  });
}

export function createFixtureCodexAdapter(): AgentAdapter {
  return buildFixtureAdapter(buildDescriptor("hall.codex", "Codex", "codex"), {
    installed: true,
    availability: "available",
    executionTrust: "trusted_local",
    capabilityObservations: [...IMPLEMENTATION_CAPABILITIES],
    limitations: [
      "Trusted-local mode: Codex sandbox and approval protections are bypassed. Codex runs with the Hall Core user's filesystem permissions.",
    ],
    diagnosticMessage:
      "Trusted-local mode: Codex sandbox and approval protections are bypassed. Codex runs with the Hall Core user's filesystem permissions.",
  });
}

export function createAllFixtureAdapters(): readonly AgentAdapter[] {
  return [
    createFixtureMockAgentAdapter(),
    createFixtureClaudeCodeAdapter(),
    createFixtureCodexAdapter(),
  ];
}

/**
 * Phase 12 — unlike every adapter above, this one's `startTask()` actually
 * completes: it writes a small fixed file into the given
 * `AgentTaskInput.workingDirectory` (the candidate's own Git worktree,
 * for the multi-agent comparison feature) and emits a real
 * `run.started` -> `run.completed` lifecycle. Never used by the routing/
 * assignment E2E specs (those intentionally never click "Start" and rely
 * on every fixture rejecting `startTask()`); used only by the comparison
 * E2E spec, which needs to observe a real candidate reach a terminal
 * status and produce real result evidence. No real filesystem access
 * outside the worktree it's handed, no network access, no subscription
 * usage of any kind — this is still a fully deterministic, offline
 * fixture, not a real Claude Code/Codex process.
 */
export function createFixtureComparisonAdapter(input: {
  readonly adapterId: string;
  readonly displayName: string;
  readonly fileName: string;
  readonly fileContent: string;
}): AgentAdapter {
  const descriptor = buildDescriptor(input.adapterId, input.displayName, input.adapterId);
  return {
    descriptor,
    detect(): Promise<AgentDetectionResult> {
      return Promise.resolve({
        installed: true,
        availability: "available",
        executionTrust: "isolated",
        capabilityObservations: [...IMPLEMENTATION_CAPABILITIES],
      });
    },
    startTask(taskInput: AgentTaskInput): Promise<AgentRunHandle> {
      fs.writeFileSync(path.join(taskInput.workingDirectory, input.fileName), input.fileContent);

      const envelope = {
        protocolVersion: "0.1" as const,
        runId: taskInput.runId,
        taskId: taskInput.hallTask.taskId,
        agentId: taskInput.agentIdentity.agentId,
        timestamp: new Date().toISOString(),
      };
      const startedEvent: NormalizedAgentEvent = {
        ...envelope,
        eventId: randomUUID(),
        sequence: 0,
        type: "run.started",
        payload: {},
      };
      const completedEvent: NormalizedAgentEvent = {
        ...envelope,
        eventId: randomUUID(),
        sequence: 1,
        type: "run.completed",
        payload: {},
      };
      const events: readonly NormalizedAgentEvent[] = [startedEvent, completedEvent];
      const currentState: RunTerminalState = "running";

      return Promise.resolve({
        runId: taskInput.runId,
        currentState,
        completion: Promise.resolve(completedEvent),
        events: {
          [Symbol.asyncIterator]() {
            let index = 0;
            return {
              next(): Promise<IteratorResult<NormalizedAgentEvent>> {
                const value = events.at(index);
                if (value === undefined) return Promise.resolve({ done: true, value: undefined });
                index += 1;
                return Promise.resolve({ done: false, value });
              },
            };
          },
        },
        cancel(): void {
          // no-op fixture: the event list is fixed at construction time.
        },
      });
    },
  };
}

/**
 * Phase 15.1 — CEO plan execution E2E specs need a fixture adapter whose
 * `startTask()` genuinely runs to a real terminal event (unlike every
 * adapter above, whose `startTask()` always rejects — see this file's own
 * header comment and `MOCK_AGENT_ADAPTER_ID`'s fixed reject-everything
 * registration in `fixture-server.ts`, which every routing/assignment/
 * planning spec still relies on unchanged).
 *
 * Rather than hand-rolling a parallel reimplementation of failure/retry
 * event shapes, this wraps the REAL, already-published, already-tested
 * `@hall-of-wisdom/mock-agent` package (the exact same class
 * `apps/server`'s own test suites use) — but `MockAgentAdapter`'s
 * `descriptor` is a fixed module-level constant
 * (`MOCK_AGENT_ADAPTER_ID` == `"hall.mock-agent"`), which would collide
 * with `createFixtureMockAgentAdapter()`'s own registration under that
 * same id if registered as-is. This wrapper overrides `descriptor` (a new
 * adapter id + display name, revalidated through the SDK's own
 * `parseAgentAdapterDescriptor`) AND `detect()`'s reported trust/
 * capabilities — matching `createFixtureComparisonAdapter`'s own
 * established precedent of declaring `executionTrust: "isolated"` plus
 * `IMPLEMENTATION_CAPABILITIES` — because the delegated child tasks these
 * E2E specs need to actually run inherit `requirements` from their parent
 * task's own routing profile ("Code implementation — isolated
 * preferred": `project.read`/`project.edit`/`structured.events`/
 * `cancellation`, `allowedExecutionTrust: ["isolated"]`); the real Mock
 * Agent's own honest, narrow profile (`simulated` trust, no file editing)
 * would leave every wrapped instance showing "does not meet requirements"
 * and disabled in the real "Assign an agent" dialog, same as
 * `hall.mock-agent` itself already does for such a task — unselectable
 * through genuine UI regardless of adapter id. `startTask()` still
 * delegates unchanged to the real instance for its deterministic
 * success/failure/retry event behavior — still fully deterministic,
 * offline, no real provider process, no subscription usage of any kind.
 */
function withAdapterId(
  adapter: AgentAdapter,
  adapterId: string,
  displayName: string,
): AgentAdapter {
  // `agentDisplayName` in the `/api/v1/adapters` response (and this
  // dialog's own `<option>` text) is read from
  // `descriptor.supportedAgent.displayName`, NOT `descriptor.displayName`
  // — both must be overridden, or every wrapped instance still renders
  // as the wrapped adapter's own original display name ("Mock Agent"),
  // indistinguishable from `hall.mock-agent` itself and from each other.
  const descriptor: AgentAdapterDescriptor = parseAgentAdapterDescriptor({
    ...adapter.descriptor,
    adapterId,
    displayName,
    // `integrationLevel` MUST also be overridden, not just left as the
    // wrapped `MockAgentAdapter`'s own `"native"` — `evaluateRouting`'s
    // tie-break (`routing-policy.ts`) ranks a lower integration level
    // ABOVE `"structured_cli"` (Claude Code's own declared level), so a
    // still-`"native"` wrapped instance would silently outrank Claude
    // Code for every OTHER spec's "isolated" routing recommendation —
    // a real regression this file's own author found by running the
    // full existing E2E suite after adding these adapters, not a
    // hypothetical. Matched to Claude Code's level so the final
    // tie-break is the adapter-id alphabetical sort below, which this
    // file's ids are deliberately named to lose.
    integrationLevel: "structured_cli",
    capabilities: { ...adapter.descriptor.capabilities, fileEditing: true, shellExecution: true },
    declaredCapabilities: ["project.read", "project.edit", "structured.events", "cancellation"],
    supportedAgent: {
      ...adapter.descriptor.supportedAgent,
      adapterId,
      displayName,
      agentId: adapterId,
    },
  });
  return {
    descriptor,
    async detect(): Promise<AgentDetectionResult> {
      const real = await adapter.detect();
      return {
        ...real,
        executionTrust: "isolated",
        capabilityObservations: [...IMPLEMENTATION_CAPABILITIES],
      };
    },
    startTask: (input, options) => adapter.startTask(input, options),
  };
}

function fixtureMockAgent(scenario: MockAgentScenario, failureRetryable?: boolean): AgentAdapter {
  return new MockAgentAdapter({
    scenario,
    stepDelayMs: scenario === "cancellable" ? 5000 : 0,
    ...(failureRetryable !== undefined ? { failureRetryable } : {}),
  });
}

/** Always completes successfully — the default for CEO execution E2E specs that don't need a failure path. */
export function createCeoExecutionSuccessAdapter(): AgentAdapter {
  return withAdapterId(
    fixtureMockAgent("success"),
    "hall.zzz-ceo-fixture-success",
    "CEO Execution Fixture (success)",
  );
}

/** Always fails with `retryable: true` — drives the automatic-retry path deterministically. */
export function createCeoExecutionTransientFailureAdapter(): AgentAdapter {
  return withAdapterId(
    fixtureMockAgent("failure", true),
    "hall.zzz-ceo-fixture-transient",
    "CEO Execution Fixture (transient failure)",
  );
}

/** `createCeoExecutionTransientThenSuccessAdapter`'s "seen" markers, one empty file per already-attempted taskId — see that function's own doc comment for why this is a directory on disk, not an in-memory `Set`. */
const TRANSIENT_THEN_SUCCESS_MARKER_DIR = path.join(
  os.tmpdir(),
  "hall-e2e-transient-then-success-markers",
);

/**
 * Fails with `retryable: true` on a child task's FIRST attempt only, then
 * succeeds on every subsequent attempt for that same task — deterministic
 * proof that governed retry doesn't just relaunch (any transient-failure
 * adapter already shows that) but produces a genuinely different, better
 * outcome the second time. Keyed by `hallTask.taskId`, never by call
 * count alone, so two different steps each get their own independent
 * "first attempt" — this adapter can be assigned to more than one step in
 * the same run without cross-contaminating each other's attempt count.
 *
 * Phase 15.5 — the "seen" marker is a file on disk
 * (`TRANSIENT_THEN_SUCCESS_MARKER_DIR`), not an in-memory `Set`: this
 * adapter is re-constructed from scratch on every `fixture-server.ts`
 * boot (a brand new closure, a brand new empty `Set`), so an in-memory
 * marker would silently forget every already-failed task across a
 * restart — a step whose one real attempt happened before the restart
 * would look like a fresh "first attempt" again after it, and fail
 * forever instead of succeeding on its due retry. `taskId`s are globally
 * unique per run, so the marker file name can never collide across
 * tests or across a real vs. fixture task.
 */
export function createCeoExecutionTransientThenSuccessAdapter(): AgentAdapter {
  const failureAdapter = fixtureMockAgent("failure", true);
  const successAdapter = fixtureMockAgent("success");
  const base: AgentAdapter = {
    descriptor: failureAdapter.descriptor,
    detect: () => failureAdapter.detect(),
    startTask: (input, options) => {
      const taskId = input.hallTask.taskId;
      fs.mkdirSync(TRANSIENT_THEN_SUCCESS_MARKER_DIR, { recursive: true });
      const markerPath = path.join(TRANSIENT_THEN_SUCCESS_MARKER_DIR, taskId);
      const isFirstAttempt = !fs.existsSync(markerPath);
      fs.writeFileSync(markerPath, "");
      return isFirstAttempt
        ? failureAdapter.startTask(input, options)
        : successAdapter.startTask(input, options);
    },
  };
  return withAdapterId(
    base,
    "hall.zzz-ceo-fixture-transient-then-success",
    "CEO Execution Fixture (transient once, then success)",
  );
}

/** Always fails with `retryable: false` — drives the circuit-breaker trip path deterministically. */
export function createCeoExecutionPermanentFailureAdapter(): AgentAdapter {
  return withAdapterId(
    fixtureMockAgent("failure", false),
    "hall.zzz-ceo-fixture-permanent",
    "CEO Execution Fixture (permanent failure)",
  );
}

/** Stays "running" until explicitly cancelled — lets a spec exercise pause/cancel/emergency-stop against a genuinely in-flight task rather than one that already raced to completion. */
export function createCeoExecutionCancellableAdapter(): AgentAdapter {
  return withAdapterId(
    fixtureMockAgent("cancellable"),
    "hall.zzz-ceo-fixture-cancellable",
    "CEO Execution Fixture (cancellable)",
  );
}
