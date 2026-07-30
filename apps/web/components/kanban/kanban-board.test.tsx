import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { EnsureBoardResponse, TaskRecord } from "../../lib/api-schemas";
import { KanbanBoard } from "./kanban-board";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return {
    ...actual,
    listTasks: vi.fn(),
    listAdapters: vi.fn(),
    createDeferredTask: vi.fn(),
    transitionTask: vi.fn(),
    assignTask: vi.fn(),
    startTask: vi.fn(),
    cancelTask: vi.fn(),
    ensureTaskBoard: vi.fn(),
  };
});

const mockRouter = { push: vi.fn(), replace: vi.fn() };
vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
}));

const BASE_URL = "http://127.0.0.1:4310";

function makeRecord(overrides: Partial<TaskRecord["task"]> = {}, runId?: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    task: {
      taskId: overrides.taskId ?? "task-1",
      projectId: "project-1",
      title: "Fix the bug",
      description: "",
      priority: "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    runId,
    adapterId: runId !== undefined ? "hall.mock-agent" : undefined,
    agentId: runId !== undefined ? "mock-agent" : undefined,
    eventCount: 0,
    cancellationRequested: false,
    createdAt: now,
  };
}

describe("KanbanBoard", () => {
  beforeEach(() => {
    vi.mocked(apiClient.listTasks).mockReset();
    vi.mocked(apiClient.listAdapters).mockReset();
    vi.mocked(apiClient.createDeferredTask).mockReset();
    vi.mocked(apiClient.transitionTask).mockReset();
    vi.mocked(apiClient.assignTask).mockReset();
    vi.mocked(apiClient.startTask).mockReset();
    vi.mocked(apiClient.cancelTask).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders all 10 columns with an empty state when there are no tasks", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
    render(<KanbanBoard baseUrl={BASE_URL} />);
    for (const label of [
      "Backlog",
      "Ready",
      "Assigned",
      "In Progress",
      "Agent Review",
      "Human Approval",
      "Blocked",
      "Completed",
      "Failed",
      "Cancelled",
    ]) {
      expect(await screen.findByRole("heading", { name: label })).toBeInTheDocument();
    }
    const noTasks = screen.getAllByText("No tasks");
    expect(noTasks).toHaveLength(10);
  });

  it("shows correct task counts per column", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [
        makeRecord({ taskId: "t1", title: "Task one", status: "backlog" }),
        makeRecord({ taskId: "t2", title: "Task two", status: "backlog" }),
        makeRecord({ taskId: "t3", title: "Task three", status: "ready" }),
      ],
    });
    render(<KanbanBoard baseUrl={BASE_URL} />);
    await screen.findByText("Task one");
    const backlogHeading = screen.getByRole("heading", { name: "Backlog" });
    const backlogColumn = backlogHeading.closest("section");
    if (!backlogColumn) throw new Error("Backlog column section not found");
    expect(within(backlogColumn).getByLabelText("2 tasks")).toBeInTheDocument();
  });

  it("the Agent Review and Human Approval columns show a not-automated-yet note", async () => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
    render(<KanbanBoard baseUrl={BASE_URL} />);
    await screen.findByRole("heading", { name: "Agent Review" });
    const notes = screen.getAllByText("Not automated yet — a later phase.");
    expect(notes).toHaveLength(2);
  });

  it("creating a backlog task adds it to the Backlog column", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
    const now = new Date().toISOString();
    vi.mocked(apiClient.createDeferredTask).mockResolvedValue({
      task: {
        taskId: "task-new",
        projectId: "project-1",
        title: "New planning task",
        description: "",
        priority: "normal",
        status: "backlog",
        dependencyTaskIds: [],
        createdAt: now,
        updatedAt: now,
      },
      eventCount: 0,
      cancellationRequested: false,
      createdAt: now,
    });
    render(<KanbanBoard baseUrl={BASE_URL} />);
    await waitFor(() => {
      expect(screen.getAllByText("No tasks")).toHaveLength(10);
    });

    await user.click(screen.getByRole("button", { name: "+ New backlog task" }));
    await user.type(screen.getByLabelText("Project"), "project-1");
    await user.type(screen.getByLabelText("Title"), "New planning task");

    // Reflect the created task on the next refresh.
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [
        {
          task: {
            taskId: "task-new",
            projectId: "project-1",
            title: "New planning task",
            description: "",
            priority: "normal",
            status: "backlog",
            dependencyTaskIds: [],
            createdAt: now,
            updatedAt: now,
          },
          eventCount: 0,
          cancellationRequested: false,
          createdAt: now,
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Add to Backlog" }));

    await waitFor(() => {
      expect(screen.getByText("New planning task")).toBeInTheDocument();
    });
  });

  it("moving a card via the action menu calls transitionTask and refreshes", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listTasks).mockResolvedValueOnce({
      tasks: [makeRecord({ status: "backlog" })],
    });
    const now = new Date().toISOString();
    vi.mocked(apiClient.transitionTask).mockResolvedValue({
      task: { ...makeRecord().task, status: "ready", updatedAt: now },
      eventCount: 0,
      cancellationRequested: false,
      createdAt: now,
    });
    render(<KanbanBoard baseUrl={BASE_URL} />);
    await screen.findByText("Fix the bug");

    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [makeRecord({ status: "ready" })],
    });

    const [firstActionsButton] = screen.getAllByRole("button", { name: "Actions" });
    if (!firstActionsButton) throw new Error("Actions button not found");
    await user.click(firstActionsButton);
    await user.click(screen.getByRole("button", { name: "Move to Ready" }));

    await waitFor(() => {
      expect(apiClient.transitionTask).toHaveBeenCalledWith(BASE_URL, "task-1", "ready");
    });
    await waitFor(() => {
      const card = screen.getByText("Fix the bug").closest("li");
      if (!card) throw new Error("card not found");
      expect(within(card).getByText("Ready")).toBeInTheDocument();
    });
  });

  it("Open discussion calls ensureTaskBoard and navigates to /boards?boardId=<encoded boardId>", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [makeRecord({ status: "backlog" })],
    });
    vi.mocked(apiClient.ensureTaskBoard).mockResolvedValueOnce({
      board: {
        boardId: "task:task-1",
        kind: "task",
        title: "Discussion: Fix the bug",
        taskId: "task-1",
        projectId: "project-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      },
      messagesPath: "/api/v1/boards/task:task-1/messages",
      livePath: "/api/v1/boards/task:task-1/messages/live",
    });
    render(<KanbanBoard baseUrl={BASE_URL} />);
    await screen.findByText("Fix the bug");

    const [firstActionsButton] = screen.getAllByRole("button", { name: "Actions" });
    if (!firstActionsButton) throw new Error("Actions button not found");
    await user.click(firstActionsButton);
    await user.click(screen.getByRole("button", { name: "Open discussion" }));

    await waitFor(() => {
      expect(apiClient.ensureTaskBoard).toHaveBeenCalledWith(BASE_URL, "task-1");
    });
    await waitFor(() => {
      expect(mockRouter.push).toHaveBeenCalledWith(
        `/boards?boardId=${encodeURIComponent("task:task-1")}`,
      );
    });
  });

  it("repeated Open discussion clicks select the same board (no duplicate creation attempted mid-flight)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [makeRecord({ status: "backlog" })],
    });
    let resolveEnsure!: (value: EnsureBoardResponse) => void;
    vi.mocked(apiClient.ensureTaskBoard).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEnsure = resolve;
      }),
    );
    render(<KanbanBoard baseUrl={BASE_URL} />);
    await screen.findByText("Fix the bug");

    const [firstActionsButton] = screen.getAllByRole("button", { name: "Actions" });
    if (!firstActionsButton) throw new Error("Actions button not found");
    await user.click(firstActionsButton);
    await user.click(screen.getByRole("button", { name: "Open discussion" }));

    // The card is now pending (busy) — its Actions button is disabled, so a
    // second click cannot even reach handleAction while the first request
    // is still in flight.
    expect(screen.getByRole("button", { name: "Actions" })).toBeDisabled();

    resolveEnsure({
      board: {
        boardId: "task:task-1",
        kind: "task",
        title: "Discussion: Fix the bug",
        taskId: "task-1",
        projectId: "project-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      },
      messagesPath: "/api/v1/boards/task:task-1/messages",
      livePath: "/api/v1/boards/task:task-1/messages/live",
    });

    await waitFor(() => {
      expect(apiClient.ensureTaskBoard).toHaveBeenCalledTimes(1);
    });
  });

  it("announces the result of a move through the live region", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [makeRecord({ status: "backlog" })],
    });
    const now = new Date().toISOString();
    vi.mocked(apiClient.transitionTask).mockResolvedValue({
      task: { ...makeRecord().task, status: "blocked", updatedAt: now },
      eventCount: 0,
      cancellationRequested: false,
      createdAt: now,
    });
    render(<KanbanBoard baseUrl={BASE_URL} />);
    await screen.findByText("Fix the bug");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("button", { name: "Move to Blocked" }));

    await waitFor(() => {
      expect(screen.getByText(/Task moved to blocked/)).toBeInTheDocument();
    });
  });

  it("a card mid-operation cannot start a second mutation (pending lock)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [makeRecord({ status: "backlog" })],
    });
    let resolveTransition: (value: TaskRecord) => void = () => undefined;
    vi.mocked(apiClient.transitionTask).mockReturnValue(
      new Promise((resolve) => {
        resolveTransition = resolve;
      }),
    );
    render(<KanbanBoard baseUrl={BASE_URL} />);
    await screen.findByText("Fix the bug");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("button", { name: "Move to Ready" }));

    // While pending, the Actions button is disabled — a second move cannot be initiated.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Actions" })).toBeDisabled();
    });
    expect(apiClient.transitionTask).toHaveBeenCalledTimes(1);

    const now = new Date().toISOString();
    resolveTransition({
      task: { ...makeRecord().task, status: "ready", updatedAt: now },
      eventCount: 0,
      cancellationRequested: false,
      createdAt: now,
    });
  });

  it("keeps existing cards visible and shows a warning when a refresh fails", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listTasks)
      .mockResolvedValueOnce({ tasks: [makeRecord({ status: "backlog" })] })
      .mockRejectedValueOnce(new apiClient.ApiClientError("NETWORK_ERROR", "offline"));
    render(<KanbanBoard baseUrl={BASE_URL} />);
    await screen.findByText("Fix the bug");

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(screen.getByText(/Could not refresh the task list/)).toBeInTheDocument();
    });
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
  });

  it("filters hide non-matching cards, and Clear filters restores them", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [
        makeRecord({ taskId: "t1", title: "Fix login", status: "backlog" }),
        makeRecord({ taskId: "t2", title: "Write docs", status: "backlog" }),
      ],
    });
    render(<KanbanBoard baseUrl={BASE_URL} />);
    await screen.findByText("Fix login");
    expect(screen.getByText("Write docs")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search"), "login");
    expect(screen.queryByText("Write docs")).not.toBeInTheDocument();
    expect(screen.getByText("Fix login")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Write docs")).toBeInTheDocument();
  });

  it("a poll-driven board re-render while the assign dialog is open does not steal focus from the field the user is editing", async () => {
    // Regression test for an unmemoized onClose prop: KanbanBoard re-renders
    // on every poll/refresh tick, and AssignDialog's Dialog wrapper resets
    // focus in an effect keyed on `onClose`'s identity — if that identity
    // isn't stable across renders, an in-progress dialog interaction gets
    // its focus yanked back to the dialog's first field on every refresh.
    const user = userEvent.setup();
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [makeRecord({ status: "ready" })],
    });
    vi.mocked(apiClient.listAdapters).mockResolvedValue({
      adapters: [
        {
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
        },
      ],
    });
    render(<KanbanBoard baseUrl={BASE_URL} />);
    await screen.findByText("Fix the bug");

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("button", { name: "Assign agent" }));
    await waitFor(() => screen.getByRole("option", { name: "Mock Agent" }));

    const workingDirectoryField = screen.getByLabelText(/Working directory/);
    await user.click(workingDirectoryField);
    await user.type(workingDirectoryField, "src");
    expect(workingDirectoryField).toHaveFocus();

    // Trigger the same kind of board re-render polling causes, without
    // clicking anything on the page (a click would itself move focus to
    // whatever was clicked, confounding the assertion below) — the
    // polling hook's own `window.focus` listener is a real, non-pointer
    // trigger for exactly this refresh.
    vi.mocked(apiClient.listTasks).mockResolvedValue({
      tasks: [makeRecord({ status: "ready" })],
    });
    // `waitFor` on the mock's call count alone is not enough: the count
    // increments synchronously the moment `listTasks()` is invoked, well
    // before its resolved promise's `.then()` (which is what actually
    // updates state and re-renders `KanbanBoard`) has had a chance to
    // run — asserting immediately after would race the very re-render
    // this test exists to observe. Explicitly flush the microtask queue
    // (inside `act`) so the state update, re-render, and any resulting
    // effect re-run have all genuinely completed first.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(apiClient.listTasks).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workingDirectoryField).toHaveFocus();
    expect(workingDirectoryField).toHaveValue("src");
  });

  // Phase 14.3 — layout containment. jsdom performs no real CSS layout
  // (`getBoundingClientRect` is always zero), so these assert the actual
  // structural/class-level contract that prevents document-level
  // horizontal overflow, rather than simulating geometry; the real
  // browser regression (`move-menu-accumulation.spec.ts`) verifies the
  // resulting numbers.
  describe("mobile/overflow layout contract", () => {
    it("the columns row establishes its own containing block and contains its own horizontal scroll", async () => {
      vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
      render(<KanbanBoard baseUrl={BASE_URL} />);
      await screen.findByRole("heading", { name: "Backlog" });
      const grid = screen
        .getByRole("heading", { name: "Backlog" })
        .closest("section")?.parentElement;
      if (!grid) throw new Error("columns row not found");
      // `relative` gives every descendant (including any `position:
      // absolute` element, e.g. an `sr-only` label inside a card) a local
      // containing block scoped to this row — without it, an absolutely
      // positioned descendant's un-scrolled static position can leak past
      // this row's own `overflow-x-auto` clipping and widen
      // `document.documentElement` itself, even though the row's own
      // visible content stays correctly scrollable. This is the actual
      // Phase 14.3 root cause and fix — see
      // `docs/architecture/0014-ceo-planning-approval-and-delegation.md`.
      expect(grid.className).toMatch(/\brelative\b/);
      expect(grid.className).toMatch(/\boverflow-x-auto\b/);
    });

    it("the scrollable columns row has an accessible name announcing that it scrolls", async () => {
      vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
      render(<KanbanBoard baseUrl={BASE_URL} />);
      const region = await screen.findByRole("region", {
        name: /scrollable horizontally/i,
      });
      expect(region).toContainElement(
        (await screen.findByRole("heading", { name: "Backlog" })).closest("section"),
      );
    });

    it("every column keeps its intended fixed usable width and never shrinks", async () => {
      vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
      render(<KanbanBoard baseUrl={BASE_URL} />);
      const headings = await Promise.all(
        [
          "Backlog",
          "Ready",
          "Assigned",
          "In Progress",
          "Agent Review",
          "Human Approval",
          "Blocked",
          "Completed",
          "Failed",
          "Cancelled",
        ].map((label) => screen.findByRole("heading", { name: label })),
      );
      expect(headings).toHaveLength(10);
      for (const heading of headings) {
        const section = heading.closest("section");
        if (!section) throw new Error("column section not found");
        expect(section.className).toMatch(/\bw-72\b/);
        expect(section.className).toMatch(/\bshrink-0\b/);
      }
    });

    it("a long, unbroken task title does not disable wrapping on the card", async () => {
      const longTitle = "a".repeat(200);
      vi.mocked(apiClient.listTasks).mockResolvedValue({
        tasks: [makeRecord({ title: longTitle })],
      });
      render(<KanbanBoard baseUrl={BASE_URL} />);
      const titleButton = await screen.findByRole("button", {
        name: new RegExp(`^Drag ${longTitle}`),
      });
      expect(titleButton.className).toMatch(/\bbreak-words\b/);
    });

    it("card metadata (project, priority, assigned agent) wraps rather than forcing the column wider", async () => {
      vi.mocked(apiClient.listTasks).mockResolvedValue({
        tasks: [makeRecord({ projectId: "p".repeat(120) }, "run-1")],
      });
      render(<KanbanBoard baseUrl={BASE_URL} />);
      await screen.findByText("Fix the bug");
      const dl = document.querySelector("dl");
      if (!dl) throw new Error("metadata <dl> not found");
      expect(dl.className).toMatch(/\bbreak-words\b/);
    });

    it("the MoveMenu trigger ('Actions') remains present and reachable regardless of viewport", async () => {
      vi.mocked(apiClient.listTasks).mockResolvedValue({
        tasks: [makeRecord({ status: "backlog" })],
      });
      render(<KanbanBoard baseUrl={BASE_URL} />);
      const trigger = await screen.findByRole("button", { name: "Actions" });
      expect(trigger).toBeEnabled();
      expect(trigger).toBeVisible();
    });

    it("all 10 workflow columns render side by side (desktop multi-column layout preserved)", async () => {
      vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
      render(<KanbanBoard baseUrl={BASE_URL} />);
      const backlog = await screen.findByRole("heading", { name: "Backlog" });
      const grid = backlog.closest("section")?.parentElement;
      if (!grid) throw new Error("columns row not found");
      // A row layout (`flex`), not a stack (`flex-col`) — columns sit
      // side by side, scrolling horizontally as a unit when they don't
      // fit, rather than wrapping or stacking vertically.
      expect(grid.className).toMatch(/\bflex\b/);
      expect(grid.className).not.toMatch(/\bflex-col\b/);
      expect(grid.children).toHaveLength(10);
    });

    it("does not rely on a global overflow-x:hidden workaround anywhere in the board tree", async () => {
      vi.mocked(apiClient.listTasks).mockResolvedValue({
        tasks: [makeRecord()],
      });
      const { container } = render(<KanbanBoard baseUrl={BASE_URL} />);
      await screen.findByText("Fix the bug");
      const offenders = Array.from(container.querySelectorAll("*")).filter((el) =>
        /\boverflow-x-hidden\b/.test(el.className),
      );
      expect(offenders).toHaveLength(0);
    });

    it("the title button's focus ring remains visible (focus-visible outline present)", async () => {
      vi.mocked(apiClient.listTasks).mockResolvedValue({
        tasks: [makeRecord()],
      });
      render(<KanbanBoard baseUrl={BASE_URL} />);
      const titleButton = await screen.findByRole("button", { name: /^Drag Fix the bug/ });
      expect(titleButton.className).toMatch(/focus-visible:outline-2/);
    });
  });
});
