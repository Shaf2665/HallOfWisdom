import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type {
  AdapterSummary,
  CeoDelegationLink,
  CeoPlanRun,
  CeoPlanStepExecution,
  CeoPlanVersion,
  GetCeoPlanRunResponse,
} from "../../lib/api-schemas";
import { CeoPlanExecutionSection } from "./ceo-plan-execution-section";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return {
    ...actual,
    listCeoPlanRuns: vi.fn(),
    getCeoPlanRun: vi.fn(),
    getCeoPlanRunSchedulerStatus: vi.fn(),
    listAdapters: vi.fn(),
    configureCeoPlanRunExecution: vi.fn(),
    startCeoPlanRun: vi.fn(),
    pauseCeoPlanRun: vi.fn(),
    resumeCeoPlanRun: vi.fn(),
    cancelCeoPlanRun: vi.fn(),
    emergencyStopCeoPlanRun: vi.fn(),
    retryCeoPlanRunStep: vi.fn(),
  };
});

vi.mock("../../hooks/use-ceo-plan-run-events", () => ({
  useCeoPlanRunEvents: () => ({ connectionState: "idle", events: [], lastSequence: -1 }),
}));

const BASE_URL = "http://127.0.0.1:4310";
const WS_BASE_URL = "ws://127.0.0.1:4310";
const PLAN_ID = "plan-1";
const RUN_ID = "run-1";
const STEP_ID = "step-1";
const CHILD_TASK_ID = "task-child-1";

function makeAdapter(overrides: Partial<AdapterSummary> = {}): AdapterSummary {
  return {
    adapterId: "hall.mock-agent",
    displayName: "Mock Agent",
    adapterVersion: "0.1.0",
    agentId: "mock-agent",
    agentDisplayName: "Mock Agent",
    integrationLevel: "native",
    supportedOperatingSystems: ["windows", "macos", "linux"],
    capabilities: {
      streaming: true,
      cancellation: true,
      sessionResume: false,
      toolEvents: true,
      fileEditing: false,
      shellExecution: false,
      subagents: false,
      mcp: false,
      acp: false,
    },
    availability: "available",
    declaredCapabilities: ["structured.events", "cancellation"],
    assignable: true,
    executionTrust: "simulated",
    capabilityObservations: [],
    limitations: [],
    detectedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function makeVersion(overrides: Partial<CeoPlanVersion> = {}): CeoPlanVersion {
  return {
    planId: PLAN_ID,
    version: 3,
    objective: "Ship the thing.",
    summary: "Summary.",
    assumptions: [],
    constraints: [],
    steps: [
      {
        id: STEP_ID,
        position: 0,
        title: "Implement",
        objective: "Do the work.",
        boundedInstructions: "Do exactly this.",
        acceptanceCriteria: ["Done."],
        dependencies: [],
        routingSummary: "n/a",
        selectedAdapterId: "hall.mock-agent",
      },
    ],
    createdAt: "2026-07-15T12:00:00.000Z",
    createdBy: "ceo_planner",
    contentHash: "a".repeat(64),
    ...overrides,
  };
}

function makeLinks(): readonly CeoDelegationLink[] {
  return [
    {
      planId: PLAN_ID,
      planVersion: 3,
      stepId: STEP_ID,
      childTaskId: CHILD_TASK_ID,
      adapterId: "hall.mock-agent",
      delegatedAt: "2026-07-15T12:00:00.000Z",
    },
  ];
}

function makeRun(overrides: Partial<CeoPlanRun> = {}): CeoPlanRun {
  return {
    id: RUN_ID,
    planId: PLAN_ID,
    planVersion: 3,
    status: "configured",
    executionMode: "autonomous",
    policySnapshot: {
      maxConcurrentSteps: 2,
      maxAttemptsPerStep: 2,
      allowAutomaticTransientRetry: true,
      retryBackoffSeconds: 30,
      maxPlanElapsedSeconds: 3600,
      maxStepElapsedSeconds: 600,
      maxConsecutiveFailures: 3,
      maxNoProgressAttempts: 3,
      pauseOnAnyPermanentFailure: true,
    },
    createdAt: "2026-07-15T12:00:00.000Z",
    activeGeneration: 0,
    recoveryClassification: "none",
    ...overrides,
  };
}

function makeStepExecution(overrides: Partial<CeoPlanStepExecution> = {}): CeoPlanStepExecution {
  return {
    planRunId: RUN_ID,
    planStepId: STEP_ID,
    childTaskId: CHILD_TASK_ID,
    status: "ready",
    attemptCount: 0,
    dependencySummary: {
      totalDependencies: 0,
      completedDependencies: 0,
      failedDependencies: 0,
      cancelledDependencies: 0,
    },
    readinessReason: "ready",
    ...overrides,
  };
}

function makeRunDetail(
  overrides: Partial<GetCeoPlanRunResponse> & { readonly run: CeoPlanRun },
): GetCeoPlanRunResponse {
  return {
    stepExecutions: [makeStepExecution()],
    attempts: [],
    circuit: {
      state: "closed",
      consecutiveFailures: 0,
      consecutiveSameCodeFailures: 0,
      noProgressAttempts: 0,
    },
    interventions: [],
    mutationToken: "tok-1",
    ...overrides,
  };
}

function renderSection(): void {
  render(
    <CeoPlanExecutionSection
      baseUrl={BASE_URL}
      wsBaseUrl={WS_BASE_URL}
      planId={PLAN_ID}
      version={makeVersion()}
      links={makeLinks()}
    />,
  );
}

describe("CeoPlanExecutionSection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("with no execution run yet, offers only Configure execution — no Start/Pause/Cancel/Emergency stop control is available", async () => {
    vi.mocked(apiClient.listCeoPlanRuns).mockResolvedValue({ runs: [] });

    renderSection();

    expect(await screen.findByRole("button", { name: "Configure execution…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start execution/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pause/ })).not.toBeInTheDocument();
  });

  /**
   * Phase 15.3 — `refresh()`'s out-of-order-response guard. A slow,
   * earlier-triggered `refresh()` (call generation 1) is still in flight
   * when a second, later-triggered `refresh()` (generation 2) starts and
   * completes first — the exact shape of the real race (a WS-event
   * refresh landing while a still-pending mount/mutation refresh from
   * moments earlier hasn't resolved yet). Without the generation guard,
   * generation 1's response resolving afterward would silently overwrite
   * generation 2's newer, correct state (e.g. "Attempts: 2") with its own
   * stale data (e.g. "Attempts: 1") — with nothing left to re-trigger a
   * correcting refresh once the event burst has passed.
   */
  it("discards a stale refresh response that resolves after a newer one already landed", async () => {
    const PLAN_ID_2 = "plan-2";
    const RUN_ID_2 = "run-2";
    const runGen1 = makeRun({ status: "running" });
    const runGen2 = makeRun({ id: RUN_ID_2, planId: PLAN_ID_2, status: "running" });
    let resolveGen1List: ((value: { runs: CeoPlanRun[] }) => void) | undefined;
    const gen1ListPromise = new Promise<{ runs: CeoPlanRun[] }>((resolve) => {
      resolveGen1List = resolve;
    });

    vi.mocked(apiClient.listCeoPlanRuns)
      .mockImplementationOnce(() => gen1ListPromise)
      .mockImplementationOnce(() => Promise.resolve({ runs: [runGen2] }));
    // Dispatches on the requested run id, not call order — this is what
    // makes the negative control (remove the `isStale()` guard, this test
    // must then fail) meaningful: generation 1's continuation, if it ever
    // runs, genuinely fetches ITS OWN run's stale `attemptCount: 1`, not a
    // second copy of generation 2's data.
    vi.mocked(apiClient.getCeoPlanRun).mockImplementation((_baseUrl, runId) =>
      Promise.resolve(
        runId === RUN_ID_2
          ? makeRunDetail({
              run: runGen2,
              stepExecutions: [makeStepExecution({ attemptCount: 2 })],
            })
          : makeRunDetail({
              run: runGen1,
              stepExecutions: [makeStepExecution({ attemptCount: 1 })],
            }),
      ),
    );
    vi.mocked(apiClient.getCeoPlanRunSchedulerStatus).mockResolvedValue({
      state: "active",
      pendingSignalCount: 0,
      claimedSignalCount: 0,
      runningStepCount: 0,
      waitingForDependencyCount: 0,
      retryWaitingCount: 0,
      circuitState: "closed",
      activeAttemptCount: 1,
    });

    const { rerender } = render(
      <CeoPlanExecutionSection
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        planId={PLAN_ID}
        version={makeVersion()}
        links={makeLinks()}
      />,
    );

    // Generation 1's `refresh()` (from the mount effect) is now suspended
    // on its own `listCeoPlanRuns` call. A `planId` change gives `refresh`
    // a new identity, re-firing the mount effect and starting generation
    // 2 — which completes immediately (all its mocks resolve
    // synchronously) while generation 1 is still stuck. (A real WS-event
    // refresh would retrigger the same way, via `lastEventSequence`
    // changing — this is the cheapest reliable way to force two
    // overlapping `refresh()` calls in a component test.)
    rerender(
      <CeoPlanExecutionSection
        baseUrl={BASE_URL}
        wsBaseUrl={WS_BASE_URL}
        planId={PLAN_ID_2}
        version={makeVersion({ planId: PLAN_ID_2 })}
        links={makeLinks()}
      />,
    );

    expect(await screen.findByText(/Attempts: 2/)).toBeInTheDocument();

    // Generation 1 finally resolves — with the OLD run list, well after
    // generation 2's newer, correct state already rendered.
    resolveGen1List?.({ runs: [runGen1] });

    // Give generation 1's continuation every chance to (incorrectly)
    // apply its stale data if the guard were absent.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText(/Attempts: 2/)).toBeInTheDocument();
  });

  describe("start dialog (configured, autonomous run)", () => {
    function setUp(): void {
      const run = makeRun({ status: "configured", executionMode: "autonomous" });
      vi.mocked(apiClient.listCeoPlanRuns).mockResolvedValue({ runs: [run] });
      vi.mocked(apiClient.getCeoPlanRun).mockResolvedValue(makeRunDetail({ run }));
      vi.mocked(apiClient.getCeoPlanRunSchedulerStatus).mockResolvedValue({
        state: "idle",
        pendingSignalCount: 0,
        claimedSignalCount: 0,
        runningStepCount: 0,
        waitingForDependencyCount: 0,
        retryWaitingCount: 0,
        circuitState: "closed",
        activeAttemptCount: 0,
      });
      vi.mocked(apiClient.listAdapters).mockResolvedValue({
        adapters: [makeAdapter({ adapterId: "hall.mock-agent", executionTrust: "trusted_local" })],
      });
    }

    it("shows every required plan/policy field, a trusted-local warning, and both required statements", async () => {
      setUp();
      renderSection();

      await userEvent.click(await screen.findByRole("button", { name: "Start execution…" }));

      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Start execution — plan version 3");
      expect(dialog).toHaveTextContent("Approved plan version");
      expect(dialog).toHaveTextContent("3");
      expect(dialog).toHaveTextContent("Child tasks");
      expect(dialog).toHaveTextContent("1");
      expect(dialog).toHaveTextContent("None — every step is independent");
      expect(dialog).toHaveTextContent("hall.mock-agent");
      expect(dialog).toHaveTextContent("trusted_local");
      expect(dialog).toHaveTextContent("Max concurrent steps");
      expect(dialog).toHaveTextContent("2");
      expect(dialog).toHaveTextContent("Max attempts per step");
      expect(dialog).toHaveTextContent("On, 30s backoff");
      expect(dialog).toHaveTextContent("Max step elapsed time");
      expect(dialog).toHaveTextContent("10m");
      expect(dialog).toHaveTextContent("Max plan elapsed time");
      expect(dialog).toHaveTextContent("1h");
      expect(dialog).toHaveTextContent("3 consecutive / 3 no-progress");
      expect(dialog).toHaveTextContent(
        "If Hall Core restarts uncleanly while this run is active, execution pauses automatically for review — no interrupted work is retried automatically.",
      );
      expect(dialog).toHaveTextContent(
        "Hall performs no automatic replanning: it only executes the steps, dependencies, and adapters already approved in this plan version.",
      );
      // The trusted-local warning falls back to a fixed sentence when the
      // adapter carries no adapter-authored `limitationNotice` of its own.
      expect(dialog).toHaveTextContent(
        "Trusted-local: this agent runs with the Hall Core user's filesystem permissions.",
      );
    });

    it("shows the exact required authorization checkbox text, unchecked by default, and gates Start on it", async () => {
      setUp();
      renderSection();
      await userEvent.click(await screen.findByRole("button", { name: "Start execution…" }));
      await screen.findByRole("dialog");

      const checkbox = screen.getByRole("checkbox", {
        name: "I authorize Hall to automatically start eligible child tasks under this execution policy.",
      });
      expect(checkbox).not.toBeChecked();
      const startButton = screen.getByRole("button", { name: "Start execution" });
      expect(startButton).toBeDisabled();

      await userEvent.click(checkbox);
      expect(startButton).toBeEnabled();

      await userEvent.click(startButton);
      await waitFor(() => {
        expect(apiClient.startCeoPlanRun).toHaveBeenCalledWith(BASE_URL, RUN_ID, "tok-1");
      });
    });

    it("Escape closes the start dialog without calling startCeoPlanRun, and returns focus to the trigger", async () => {
      setUp();
      renderSection();
      const trigger = await screen.findByRole("button", { name: "Start execution…" });
      await userEvent.click(trigger);
      await screen.findByRole("dialog");

      await userEvent.keyboard("{Escape}");

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(apiClient.startCeoPlanRun).not.toHaveBeenCalled();
      expect(trigger).toHaveFocus();
    });
  });

  describe("pause dialog (running run)", () => {
    function setUp(): void {
      const run = makeRun({ status: "running", startedAt: "2026-07-15T12:05:00.000Z" });
      vi.mocked(apiClient.listCeoPlanRuns).mockResolvedValue({ runs: [run] });
      vi.mocked(apiClient.getCeoPlanRun).mockResolvedValue(makeRunDetail({ run }));
      vi.mocked(apiClient.getCeoPlanRunSchedulerStatus).mockResolvedValue({
        state: "active",
        pendingSignalCount: 0,
        claimedSignalCount: 0,
        runningStepCount: 1,
        waitingForDependencyCount: 0,
        retryWaitingCount: 0,
        circuitState: "closed",
        activeAttemptCount: 1,
      });
      vi.mocked(apiClient.pauseCeoPlanRun).mockResolvedValue({ run, mutationToken: "tok-2" });
    }

    it("states exactly that new starts stop but running tasks continue, and Pause remains a separate control from Cancel/Emergency stop", async () => {
      setUp();
      renderSection();

      await userEvent.click(await screen.findByRole("button", { name: "Pause…" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent(
        "Pausing stops Hall from starting new child tasks. Tasks that are already running will continue.",
      );

      // Pause never shares its dialog instance with Cancel or Emergency
      // stop — only one dialog is open at a time and it carries only the
      // Pause-specific copy.
      expect(dialog).not.toHaveTextContent("Cancelling execution prevents");
      expect(dialog).not.toHaveTextContent("attempt to cancel only the active tasks");

      await userEvent.click(screen.getByRole("button", { name: "Pause" }));
      await waitFor(() => {
        expect(apiClient.pauseCeoPlanRun).toHaveBeenCalledWith(BASE_URL, RUN_ID, "tok-1");
      });
    });
  });

  describe("cancel-future-scheduling dialog", () => {
    function setUp(): void {
      const run = makeRun({ status: "running", startedAt: "2026-07-15T12:05:00.000Z" });
      vi.mocked(apiClient.listCeoPlanRuns).mockResolvedValue({ runs: [run] });
      vi.mocked(apiClient.getCeoPlanRun).mockResolvedValue(makeRunDetail({ run }));
      vi.mocked(apiClient.getCeoPlanRunSchedulerStatus).mockResolvedValue({
        state: "active",
        pendingSignalCount: 0,
        claimedSignalCount: 0,
        runningStepCount: 1,
        waitingForDependencyCount: 0,
        retryWaitingCount: 0,
        circuitState: "closed",
        activeAttemptCount: 1,
      });
      vi.mocked(apiClient.cancelCeoPlanRun).mockResolvedValue({
        run: { ...run, status: "cancelled" },
        mutationToken: "tok-2",
      });
    }

    it("states exactly that scheduling is prevented but active tasks are not cancelled, distinct from the emergency-stop copy", async () => {
      setUp();
      renderSection();

      await userEvent.click(
        await screen.findByRole("button", { name: "Cancel future scheduling…" }),
      );
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent(
        "Cancelling execution prevents Hall from scheduling any additional child tasks. Tasks that are already running will not be cancelled.",
      );
      expect(dialog).not.toHaveTextContent("attempt to cancel only the active tasks");

      await userEvent.click(screen.getByRole("button", { name: "Cancel future scheduling" }));
      await waitFor(() => {
        expect(apiClient.cancelCeoPlanRun).toHaveBeenCalledWith(BASE_URL, RUN_ID, "tok-1");
      });
    });
  });

  describe("emergency-stop dialog", () => {
    function setUp(activeStepStatus: CeoPlanStepExecution["status"] = "running"): void {
      const run = makeRun({ status: "running", startedAt: "2026-07-15T12:05:00.000Z" });
      vi.mocked(apiClient.listCeoPlanRuns).mockResolvedValue({ runs: [run] });
      vi.mocked(apiClient.getCeoPlanRun).mockResolvedValue(
        makeRunDetail({ run, stepExecutions: [makeStepExecution({ status: activeStepStatus })] }),
      );
      vi.mocked(apiClient.getCeoPlanRunSchedulerStatus).mockResolvedValue({
        state: "active",
        pendingSignalCount: 0,
        claimedSignalCount: 0,
        runningStepCount: 1,
        waitingForDependencyCount: 0,
        retryWaitingCount: 0,
        circuitState: "closed",
        activeAttemptCount: 1,
      });
      vi.mocked(apiClient.emergencyStopCeoPlanRun).mockResolvedValue({
        result: {
          runId: RUN_ID,
          outcomes: [
            {
              planStepId: STEP_ID,
              childTaskId: CHILD_TASK_ID,
              outcome: "cancellation_requested",
            },
          ],
          allSucceeded: true,
        },
        run: { ...run, status: "paused" },
        mutationToken: "tok-2",
      });
    }

    it("shows the active linked task count, partial-failure and unrelated-task statements, an unchecked required checkbox with the exact text, and gates the button on it", async () => {
      setUp("running");
      renderSection();

      await userEvent.click(await screen.findByRole("button", { name: "Emergency stop…" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("Active linked tasks");
      expect(dialog).toHaveTextContent("1");
      expect(dialog).toHaveTextContent(
        "Cancellation may be partial — some active tasks may not be cancellable.",
      );
      expect(dialog).toHaveTextContent("Tasks not linked to this plan run are never affected.");

      const checkbox = screen.getByRole("checkbox", {
        name: "I understand that Hall will attempt to cancel only the active tasks linked to this plan, and that some cancellations may fail.",
      });
      expect(checkbox).not.toBeChecked();
      const stopButton = screen.getByRole("button", { name: "Emergency stop" });
      expect(stopButton).toBeDisabled();

      await userEvent.click(checkbox);
      expect(stopButton).toBeEnabled();
      await userEvent.click(stopButton);
      await waitFor(() => {
        expect(apiClient.emergencyStopCeoPlanRun).toHaveBeenCalledWith(BASE_URL, RUN_ID, "tok-1");
      });
    });

    it("Escape closes the emergency-stop dialog without calling emergencyStopCeoPlanRun", async () => {
      setUp("running");
      renderSection();
      const trigger = await screen.findByRole("button", { name: "Emergency stop…" });
      await userEvent.click(trigger);
      await screen.findByRole("dialog");

      await userEvent.keyboard("{Escape}");

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(apiClient.emergencyStopCeoPlanRun).not.toHaveBeenCalled();
    });
  });
});
