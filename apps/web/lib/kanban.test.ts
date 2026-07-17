import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@hall-of-wisdom/protocol";
import type { TaskRecord } from "./api-schemas";
import {
  availableActionsFor,
  canDrag,
  COLUMN_DEFINITIONS,
  columnKindForStatus,
  DEFAULT_KANBAN_FILTERS,
  filterTasks,
  groupTasksByColumn,
  hasActiveFilters,
  isCardLocked,
  isExecutionControlledStatus,
  isPlanningStatus,
  isTerminalStatus,
  isValidDragTarget,
  manualDestinationsFor,
  resolveDragOutcome,
} from "./kanban";

const ALL_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "ready",
  "assigned",
  "running",
  "reviewing",
  "waiting_for_approval",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

function makeRecord(overrides: Partial<TaskRecord["task"]> = {}, runId?: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    task: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Test task",
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

describe("COLUMN_DEFINITIONS", () => {
  it("covers every protocol TaskStatus exactly once", () => {
    const statuses = COLUMN_DEFINITIONS.map((column) => column.status);
    expect(statuses.sort()).toEqual([...ALL_STATUSES].sort());
    expect(new Set(statuses).size).toBe(ALL_STATUSES.length);
  });
});

describe("columnKindForStatus", () => {
  it.each([
    ["backlog", "planning"],
    ["ready", "planning"],
    ["assigned", "planning"],
    ["blocked", "planning"],
    ["running", "execution"],
    ["reviewing", "future"],
    ["waiting_for_approval", "future"],
    ["completed", "terminal"],
    ["failed", "terminal"],
    ["cancelled", "terminal"],
  ] as const)("classifies %s as %s", (status, kind) => {
    expect(columnKindForStatus(status)).toBe(kind);
  });

  it("classifies every status without throwing", () => {
    for (const status of ALL_STATUSES) {
      expect(() => columnKindForStatus(status)).not.toThrow();
    }
  });

  it("throws for a genuinely unsupported status value (defense in depth)", () => {
    expect(() => columnKindForStatus("not-a-real-status" as TaskStatus)).toThrow();
  });
});

describe("isTerminalStatus / isPlanningStatus / isExecutionControlledStatus", () => {
  it("agree with columnKindForStatus for every status, with no overlap", () => {
    for (const status of ALL_STATUSES) {
      const kind = columnKindForStatus(status);
      expect(isTerminalStatus(status)).toBe(kind === "terminal");
      expect(isPlanningStatus(status)).toBe(kind === "planning");
      expect(isExecutionControlledStatus(status)).toBe(kind === "execution" || kind === "future");
      // A status is classified as exactly one of the three groups tested here.
      const memberships = [isTerminalStatus(status), isPlanningStatus(status)].filter(Boolean);
      expect(memberships.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("manualDestinationsFor", () => {
  it("matches the exact spec table for every planning status", () => {
    expect(manualDestinationsFor("backlog")).toEqual(["ready", "blocked", "cancelled"]);
    expect(manualDestinationsFor("ready")).toEqual(["backlog", "blocked", "cancelled"]);
    expect(manualDestinationsFor("assigned")).toEqual(["ready", "blocked", "cancelled"]);
    expect(manualDestinationsFor("blocked")).toEqual(["backlog", "ready", "cancelled"]);
  });

  it("is empty for every execution-controlled or terminal status", () => {
    for (const status of [
      "running",
      "reviewing",
      "waiting_for_approval",
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      expect(manualDestinationsFor(status)).toEqual([]);
    }
  });

  it("never lists running, reviewing, waiting_for_approval, completed, or failed as a destination", () => {
    const forbidden: readonly TaskStatus[] = [
      "running",
      "reviewing",
      "waiting_for_approval",
      "completed",
      "failed",
    ];
    for (const status of ALL_STATUSES) {
      for (const destination of manualDestinationsFor(status)) {
        expect(forbidden).not.toContain(destination);
      }
    }
  });
});

describe("isValidDragTarget", () => {
  it("allows ready -> assigned as a special drag-only case", () => {
    expect(isValidDragTarget("ready", "assigned")).toBe(true);
  });

  it("matches manualDestinationsFor for every non-terminal, non-special-case pair", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === "ready" && to === "assigned") continue;
        if (isTerminalStatus(to)) continue;
        expect(isValidDragTarget(from, to)).toBe(manualDestinationsFor(from).includes(to));
      }
    }
  });

  it("rejects a drop onto a terminal column even when manualDestinationsFor would allow it (cancelling is a dedicated action, not a drag target)", () => {
    for (const from of ["backlog", "ready", "assigned", "blocked"] as const) {
      expect(manualDestinationsFor(from)).toContain("cancelled");
      expect(isValidDragTarget(from, "cancelled")).toBe(false);
    }
  });

  it("never allows a drop onto running, reviewing, waiting_for_approval, or any terminal column", () => {
    const forbidden: readonly TaskStatus[] = [
      "running",
      "reviewing",
      "waiting_for_approval",
      "completed",
      "failed",
      "cancelled",
    ];
    for (const from of ALL_STATUSES) {
      for (const to of forbidden) {
        expect(isValidDragTarget(from, to)).toBe(false);
      }
    }
  });
});

describe("resolveDragOutcome", () => {
  it("resolves ready -> assigned to 'assign', never 'move' (dragging never auto-assigns)", () => {
    expect(resolveDragOutcome("ready", "assigned")).toEqual({ kind: "assign" });
  });

  it("resolves every other valid drag target to 'move' with that target status", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === "ready" && to === "assigned") continue;
        if (!isValidDragTarget(from, to)) continue;
        expect(resolveDragOutcome(from, to)).toEqual({ kind: "move", targetStatus: to });
      }
    }
  });

  it("resolves every invalid drag target to 'invalid'", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (isValidDragTarget(from, to)) continue;
        expect(resolveDragOutcome(from, to)).toEqual({ kind: "invalid" });
      }
    }
  });

  it("never resolves a drop onto a terminal column to 'move' or 'assign'", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ["completed", "failed", "cancelled"] as const) {
        expect(resolveDragOutcome(from, to)).toEqual({ kind: "invalid" });
      }
    }
  });
});

describe("isCardLocked / canDrag", () => {
  it("locks every terminal status", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const record = makeRecord({ status });
      expect(isCardLocked(record)).toBe(true);
      expect(canDrag(record)).toBe(false);
    }
  });

  it("locks running, reviewing, and waiting_for_approval", () => {
    for (const status of ["running", "reviewing", "waiting_for_approval"] as const) {
      const record = makeRecord({ status });
      expect(isCardLocked(record)).toBe(true);
    }
  });

  it("locks an assigned task once it has a runId (launching, pre-run.started)", () => {
    const record = makeRecord({ status: "assigned" }, "run-1");
    expect(isCardLocked(record)).toBe(true);
    expect(canDrag(record)).toBe(false);
  });

  it("does not lock an assigned task with no runId yet", () => {
    const record = makeRecord({ status: "assigned" }, undefined);
    expect(isCardLocked(record)).toBe(false);
    expect(canDrag(record)).toBe(true);
  });

  it("does not lock backlog, ready, or blocked", () => {
    for (const status of ["backlog", "ready", "blocked"] as const) {
      const record = makeRecord({ status });
      expect(isCardLocked(record)).toBe(false);
      expect(canDrag(record)).toBe(true);
    }
  });
});

describe("availableActionsFor", () => {
  it("backlog: Move to Ready, Move to Blocked, Cancel task, Open discussion", () => {
    const actions = availableActionsFor(makeRecord({ status: "backlog" }));
    expect(actions.map((a) => a.label)).toEqual([
      "Move to Ready",
      "Move to Blocked",
      "Cancel task",
      "Open discussion",
    ]);
  });

  it("ready: Move to Backlog, Assign agent, Move to Blocked, Cancel task, Open discussion", () => {
    const actions = availableActionsFor(makeRecord({ status: "ready" }));
    expect(actions.map((a) => a.label)).toEqual([
      "Move to Backlog",
      "Assign agent",
      "Move to Blocked",
      "Cancel task",
      "Open discussion",
    ]);
  });

  it("assigned (not started): Start task, Return to Ready, Move to Blocked, Cancel task, Open discussion", () => {
    const actions = availableActionsFor(makeRecord({ status: "assigned" }, undefined));
    expect(actions.map((a) => a.label)).toEqual([
      "Start task",
      "Return to Ready",
      "Move to Blocked",
      "Cancel task",
      "Open discussion",
    ]);
  });

  it("assigned (launching, has runId): Open discussion only (Phase 8 — a discussion may always be opened)", () => {
    const actions = availableActionsFor(makeRecord({ status: "assigned" }, "run-1"));
    expect(actions.map((a) => a.label)).toEqual(["Open discussion"]);
  });

  it("blocked: Move to Backlog, Move to Ready, Cancel task, Open discussion", () => {
    const actions = availableActionsFor(makeRecord({ status: "blocked" }));
    expect(actions.map((a) => a.label)).toEqual([
      "Move to Backlog",
      "Move to Ready",
      "Cancel task",
      "Open discussion",
    ]);
  });

  it("running: Cancel active task, Open discussion", () => {
    const actions = availableActionsFor(makeRecord({ status: "running" }, "run-1"));
    expect(actions.map((a) => a.label)).toEqual(["Cancel active task", "Open discussion"]);
  });

  it("reviewing / waiting_for_approval: Open discussion only", () => {
    for (const status of ["reviewing", "waiting_for_approval"] as const) {
      expect(availableActionsFor(makeRecord({ status }, "run-1")).map((a) => a.label)).toEqual([
        "Open discussion",
      ]);
    }
  });

  it("terminal statuses: Open discussion only (still otherwise view details only)", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(availableActionsFor(makeRecord({ status }, "run-1")).map((a) => a.label)).toEqual([
        "Open discussion",
      ]);
    }
  });

  it("never offers a move to running, reviewing, waiting_for_approval, completed, or failed for any status", () => {
    const forbidden: readonly TaskStatus[] = [
      "running",
      "reviewing",
      "waiting_for_approval",
      "completed",
      "failed",
    ];
    for (const status of ALL_STATUSES) {
      const actions = availableActionsFor(makeRecord({ status }));
      for (const action of actions) {
        if (action.kind === "move") {
          expect(forbidden).not.toContain(action.targetStatus);
        }
      }
    }
  });
});

describe("filterTasks", () => {
  const tasks: TaskRecord[] = [
    makeRecord({ taskId: "t1", title: "Fix login bug", projectId: "web", priority: "high" }),
    makeRecord({ taskId: "t2", title: "Write docs", projectId: "docs", priority: "low" }),
    makeRecord(
      { taskId: "t3", title: "Completed thing", projectId: "web", status: "completed" },
      "run-3",
    ),
  ];

  it("with default filters, returns everything", () => {
    expect(filterTasks(tasks, DEFAULT_KANBAN_FILTERS)).toHaveLength(3);
  });

  it("filters by search text against title", () => {
    const result = filterTasks(tasks, { ...DEFAULT_KANBAN_FILTERS, search: "login" });
    expect(result.map((r) => r.task.taskId)).toEqual(["t1"]);
  });

  it("filters by search text against projectId", () => {
    const result = filterTasks(tasks, { ...DEFAULT_KANBAN_FILTERS, search: "docs" });
    expect(result.map((r) => r.task.taskId)).toEqual(["t2"]);
  });

  it("search is case-insensitive", () => {
    const result = filterTasks(tasks, { ...DEFAULT_KANBAN_FILTERS, search: "LOGIN" });
    expect(result).toHaveLength(1);
  });

  it("filters by priority", () => {
    const result = filterTasks(tasks, { ...DEFAULT_KANBAN_FILTERS, priority: "high" });
    expect(result.map((r) => r.task.taskId)).toEqual(["t1"]);
  });

  it("filters by assigned agent", () => {
    const result = filterTasks(tasks, { ...DEFAULT_KANBAN_FILTERS, agentId: "mock-agent" });
    expect(result.map((r) => r.task.taskId)).toEqual(["t3"]);
  });

  it("hides terminal tasks when showTerminal is false", () => {
    const result = filterTasks(tasks, { ...DEFAULT_KANBAN_FILTERS, showTerminal: false });
    expect(result.map((r) => r.task.taskId)).toEqual(["t1", "t2"]);
  });

  it("combines filters (AND, not OR)", () => {
    const result = filterTasks(tasks, {
      ...DEFAULT_KANBAN_FILTERS,
      search: "web",
      priority: "high",
    });
    expect(result.map((r) => r.task.taskId)).toEqual(["t1"]);
  });
});

describe("hasActiveFilters", () => {
  it("is false for the default filters", () => {
    expect(hasActiveFilters(DEFAULT_KANBAN_FILTERS)).toBe(false);
  });

  it("is true when any single filter is set", () => {
    expect(hasActiveFilters({ ...DEFAULT_KANBAN_FILTERS, search: "x" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_KANBAN_FILTERS, priority: "high" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_KANBAN_FILTERS, agentId: "mock-agent" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_KANBAN_FILTERS, showTerminal: false })).toBe(true);
  });
});

describe("groupTasksByColumn", () => {
  it("returns an entry for every status, even when empty", () => {
    const grouped = groupTasksByColumn([]);
    for (const status of ALL_STATUSES) {
      expect(grouped[status]).toEqual([]);
    }
  });

  it("groups each task under its own status only", () => {
    const tasks = [
      makeRecord({ taskId: "t1", status: "backlog" }),
      makeRecord({ taskId: "t2", status: "ready" }),
      makeRecord({ taskId: "t3", status: "backlog" }),
    ];
    const grouped = groupTasksByColumn(tasks);
    expect(grouped.backlog.map((r) => r.task.taskId)).toEqual(["t1", "t3"]);
    expect(grouped.ready.map((r) => r.task.taskId)).toEqual(["t2"]);
    expect(grouped.assigned).toEqual([]);
  });

  it("preserves the input list order within each column", () => {
    const tasks = [
      makeRecord({ taskId: "z", status: "backlog" }),
      makeRecord({ taskId: "a", status: "backlog" }),
      makeRecord({ taskId: "m", status: "backlog" }),
    ];
    const grouped = groupTasksByColumn(tasks);
    expect(grouped.backlog.map((r) => r.task.taskId)).toEqual(["z", "a", "m"]);
  });
});
