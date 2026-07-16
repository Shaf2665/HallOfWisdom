import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TaskRecord } from "../../lib/api-schemas";
import { DEFAULT_KANBAN_FILTERS } from "../../lib/kanban";
import { KanbanFiltersBar } from "./kanban-filters";

function makeRecord(agentId?: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    task: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Test",
      description: "",
      priority: "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
    },
    agentId,
    eventCount: 0,
    cancellationRequested: false,
    createdAt: now,
  };
}

describe("KanbanFiltersBar", () => {
  it("Clear filters is disabled when no filter is active", () => {
    render(<KanbanFiltersBar tasks={[]} filters={DEFAULT_KANBAN_FILTERS} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeDisabled();
  });

  it("typing in search calls onChange with the updated filters", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<KanbanFiltersBar tasks={[]} filters={DEFAULT_KANBAN_FILTERS} onChange={onChange} />);
    await user.type(screen.getByLabelText("Search"), "x");
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_KANBAN_FILTERS, search: "x" });
  });

  it("Clear filters resets to defaults", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <KanbanFiltersBar
        tasks={[]}
        filters={{ ...DEFAULT_KANBAN_FILTERS, search: "x" }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onChange).toHaveBeenCalledWith(DEFAULT_KANBAN_FILTERS);
  });

  it("derives the agent filter options from the current tasks", () => {
    render(
      <KanbanFiltersBar
        tasks={[makeRecord("mock-agent"), makeRecord("other-agent")]}
        filters={DEFAULT_KANBAN_FILTERS}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: "mock-agent" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "other-agent" })).toBeInTheDocument();
  });
});
