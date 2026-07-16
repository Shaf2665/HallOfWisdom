import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskList } from "./task-list";
import type { TaskRecord } from "../lib/api-schemas";

function makeRecord(overrides: Partial<TaskRecord["task"]> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    task: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Sample task",
      description: "",
      priority: "normal",
      status: "running",
      dependencyTaskIds: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    runId: "run-1",
    adapterId: "hall.mock-agent",
    agentId: "mock-agent",
    eventCount: 2,
    cancellationRequested: false,
    createdAt: now,
  };
}

describe("TaskList", () => {
  it("shows a loading state", () => {
    render(
      <TaskList
        state="loading"
        tasks={[]}
        selectedTaskId={null}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("Loading tasks…")).toBeInTheDocument();
  });

  it("shows an empty state", () => {
    render(
      <TaskList
        state="ready"
        tasks={[]}
        selectedTaskId={null}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/No tasks yet/)).toBeInTheDocument();
  });

  it("shows an error state", () => {
    render(
      <TaskList
        state="error"
        tasks={[]}
        selectedTaskId={null}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Tasks could not be loaded.");
  });

  it("supports keyboard task selection", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <TaskList
        state="ready"
        tasks={[makeRecord()]}
        selectedTaskId={null}
        onSelect={onSelect}
        onRefresh={vi.fn()}
      />,
    );
    const item = screen.getByRole("button", { name: /Sample task/ });
    item.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("task-1");
  });

  it("calls onRefresh when the Refresh button is clicked", async () => {
    const onRefresh = vi.fn();
    const user = userEvent.setup();
    render(
      <TaskList
        state="ready"
        tasks={[]}
        selectedTaskId={null}
        onSelect={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalled();
  });
});
