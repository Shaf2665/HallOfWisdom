import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DndContext } from "@dnd-kit/core";
import type { TaskStatus } from "@hall-of-wisdom/protocol";
import type { TaskRecord } from "../../lib/api-schemas";
import { KanbanCard } from "./kanban-card";

afterEach(() => {
  cleanup();
});

function makeRecord(overrides: Partial<TaskRecord["task"]> = {}, runId?: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    task: {
      taskId: "task-1",
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

function renderCard(
  record: TaskRecord,
  overrides: Partial<{
    isPending: boolean;
    shouldFocusOnMount: boolean;
    onMove: (taskId: string, target: TaskStatus) => Promise<void>;
    onOpenAssign: (record: TaskRecord) => void;
    onStart: (taskId: string) => Promise<void>;
    onCancel: (record: TaskRecord) => Promise<void>;
  }> = {},
) {
  const onMove =
    overrides.onMove ??
    vi.fn<(taskId: string, target: TaskStatus) => Promise<void>>().mockResolvedValue(undefined);
  const onOpenAssign = overrides.onOpenAssign ?? vi.fn<(record: TaskRecord) => void>();
  const onStart =
    overrides.onStart ?? vi.fn<(taskId: string) => Promise<void>>().mockResolvedValue(undefined);
  const onCancel =
    overrides.onCancel ??
    vi.fn<(record: TaskRecord) => Promise<void>>().mockResolvedValue(undefined);
  const onFocusHandled = vi.fn();

  const { container } = render(
    <DndContext>
      <ul>
        <KanbanCard
          record={record}
          isPending={overrides.isPending ?? false}
          shouldFocusOnMount={overrides.shouldFocusOnMount ?? false}
          onFocusHandled={onFocusHandled}
          onMove={onMove}
          onOpenAssign={onOpenAssign}
          onStart={onStart}
          onCancel={onCancel}
        />
      </ul>
    </DndContext>,
  );

  return { container, onMove, onOpenAssign, onStart, onCancel, onFocusHandled };
}

describe("KanbanCard", () => {
  it("shows title, project, priority, status, and event count", () => {
    renderCard(makeRecord({ title: "Fix the bug", projectId: "web", priority: "high" }));
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
    expect(screen.getByText("0 events")).toBeInTheDocument();
  });

  it("shows the assigned agent when present", () => {
    renderCard(makeRecord({ status: "assigned" }, "run-1"));
    expect(screen.getByText("mock-agent")).toBeInTheDocument();
  });

  it("shows a failure code when present, never a raw error", () => {
    const record = makeRecord({ status: "failed" }, "run-1");
    render(
      <DndContext>
        <ul>
          <KanbanCard
            record={{
              ...record,
              failure: { code: "MOCK_EXECUTION_FAILED", message: "The agent reported a failure." },
            }}
            isPending={false}
            shouldFocusOnMount={false}
            onFocusHandled={vi.fn()}
            onMove={vi.fn()}
            onOpenAssign={vi.fn()}
            onStart={vi.fn()}
            onCancel={vi.fn()}
          />
        </ul>
      </DndContext>,
    );
    expect(screen.getByText(/Failure: MOCK_EXECUTION_FAILED/)).toBeInTheDocument();
  });

  it("shows a cancellation-requested indicator", () => {
    const record = makeRecord({ status: "running" }, "run-1");
    render(
      <DndContext>
        <ul>
          <KanbanCard
            record={{ ...record, cancellationRequested: true }}
            isPending={false}
            shouldFocusOnMount={false}
            onFocusHandled={vi.fn()}
            onMove={vi.fn()}
            onOpenAssign={vi.fn()}
            onStart={vi.fn()}
            onCancel={vi.fn()}
          />
        </ul>
      </DndContext>,
    );
    expect(screen.getByText("Cancellation requested")).toBeInTheDocument();
  });

  it("launching (assigned with a runId): shows Starting…, no Start button, no action menu", () => {
    renderCard(makeRecord({ status: "assigned" }, "run-1"));
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
  });

  it("assigned (not started): shows a Start button and an Actions menu", () => {
    renderCard(makeRecord({ status: "assigned" }, undefined));
    expect(screen.getByRole("button", { name: "Start task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions" })).toBeInTheDocument();
  });

  it("terminal cards have no action menu", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      cleanup();
      renderCard(makeRecord({ status }, "run-1"));
      expect(screen.queryByRole("button", { name: "Actions" })).not.toBeInTheDocument();
    }
  });

  it("running cards show only a Cancel active task action, and cannot be dragged", () => {
    renderCard(makeRecord({ status: "running" }, "run-1"));
    const button = screen.getByRole("button", { name: "Actions" });
    expect(button).toBeInTheDocument();
    const dragHandle = screen.getByText("Fix the bug");
    expect(dragHandle).toHaveAttribute("aria-disabled", "true");
  });

  it("Move menu lists only the permitted destinations for a backlog card", async () => {
    const user = userEvent.setup();
    renderCard(makeRecord({ status: "backlog" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("button", { name: "Move to Ready" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to Blocked" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel task" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move to In Progress/ })).not.toBeInTheDocument();
  });

  it("renders the open Move menu popover through a portal into document.body, never as a descendant of the card's own wrapper (Phase 7.2 — an overflow:auto column list would otherwise clip it, hiding it from mouse/touch hit-testing even though it remains focusable)", async () => {
    const user = userEvent.setup();
    const { container } = renderCard(makeRecord({ status: "backlog" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const menuItem = screen.getByRole("button", { name: "Move to Ready" });
    expect(container.contains(menuItem)).toBe(false);
    expect(document.body.contains(menuItem)).toBe(true);
  });

  it("moves focus to the first menu item when the portaled Move menu opens (Phase 7.2 — portaling to document.body took the popover out of DOM order relative to the trigger, so without an explicit focus move, Tab from the trigger would land on the next card instead of the menu)", async () => {
    const user = userEvent.setup();
    renderCard(makeRecord({ status: "backlog" }));
    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Move to Ready" })).toHaveFocus();
  });

  it("Move menu works with keyboard: Tab to it, Enter opens, Escape closes and returns focus", async () => {
    const user = userEvent.setup();
    renderCard(makeRecord({ status: "backlog" }));
    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Move to Ready" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Move to Ready" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("clicking Move to Ready calls onMove with the correct target", async () => {
    const user = userEvent.setup();
    const { onMove } = renderCard(makeRecord({ status: "backlog" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("button", { name: "Move to Ready" }));
    expect(onMove).toHaveBeenCalledWith("task-1", "ready");
  });

  it("Assign agent action calls onOpenAssign, not a direct API call", async () => {
    const user = userEvent.setup();
    const { onOpenAssign, onMove } = renderCard(makeRecord({ status: "ready" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("button", { name: "Assign agent" }));
    expect(onOpenAssign).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("refocuses the stable Actions trigger before opening the assign dialog (Phase 7.2 — the clicked 'Assign agent' popover item unmounts in the same commit that opens the dialog, so the dialog must capture a still-mounted refocus target rather than the about-to-vanish item)", async () => {
    const user = userEvent.setup();
    renderCard(makeRecord({ status: "ready" }));
    const trigger = screen.getByRole("button", { name: "Actions" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Assign agent" }));
    expect(trigger).toHaveFocus();
  });

  it("Start task requires confirmation before calling onStart", async () => {
    const user = userEvent.setup();
    const { onStart } = renderCard(makeRecord({ status: "assigned" }, undefined));
    await user.click(screen.getByRole("button", { name: "Start task" }));
    expect(onStart).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onStart).toHaveBeenCalledWith("task-1");
  });

  it("moves focus to the Confirm button when entering the start-confirmation state (Phase 7.2 — the just-clicked 'Start task' button is replaced by a Confirm/Cancel pair in the same render, and nothing else claims focus on the new element)", async () => {
    const user = userEvent.setup();
    renderCard(makeRecord({ status: "assigned" }, undefined));
    await user.click(screen.getByRole("button", { name: "Start task" }));
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
  });

  it("moves focus to the Confirm button when entering the cancel-confirmation state (Phase 7.2)", async () => {
    const user = userEvent.setup();
    renderCard(makeRecord({ status: "backlog" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
  });

  it("a pending card disables the action menu and is not draggable", () => {
    renderCard(makeRecord({ status: "backlog" }), { isPending: true });
    expect(screen.getByRole("button", { name: "Actions" })).toBeDisabled();
    expect(screen.getByText("Fix the bug")).toHaveAttribute("aria-disabled", "true");
  });

  it("planning cancellation via the Cancel task action calls onCancel with the record (no runId)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn<(record: TaskRecord) => Promise<void>>().mockResolvedValue(undefined);
    renderCard(makeRecord({ status: "backlog" }), { onCancel });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("button", { name: "Cancel task" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel.mock.calls[0]?.[0].runId).toBeUndefined();
  });

  it("active cancellation via Cancel active task calls onCancel with the record (has runId)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn<(record: TaskRecord) => Promise<void>>().mockResolvedValue(undefined);
    renderCard(makeRecord({ status: "running" }, "run-1"), { onCancel });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("button", { name: "Cancel active task" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel.mock.calls[0]?.[0].runId).toBe("run-1");
  });

  it("falls back to the title button for shouldFocusOnMount when the card has no action menu (e.g. just entered the launching state)", () => {
    // Regression test: availableActionsFor([]) means MoveMenu isn't
    // rendered at all, so actionsButtonRef.current is null — the mount
    // effect must fall back to the always-rendered title button rather
    // than silently no-op and drop focus to <body>.
    renderCard(makeRecord({ status: "assigned" }, "run-1"), { shouldFocusOnMount: true });
    expect(screen.getByRole("button", { name: /Fix the bug/ })).toHaveFocus();
  });

  it("focuses the Actions button for shouldFocusOnMount when one is present", () => {
    renderCard(makeRecord({ status: "backlog" }), { shouldFocusOnMount: true });
    expect(screen.getByRole("button", { name: "Actions" })).toHaveFocus();
  });

  it("shows a safe error message and does not crash when a move fails", async () => {
    const user = userEvent.setup();
    renderCard(makeRecord({ status: "backlog" }), {
      onMove: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(screen.getByRole("button", { name: "Move to Ready" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The action could not be completed.",
    );
  });
});
