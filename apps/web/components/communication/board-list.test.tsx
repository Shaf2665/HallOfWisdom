import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CommunicationBoard } from "@hall-of-wisdom/protocol";
import { BoardList } from "./board-list";

const generalBoard: CommunicationBoard = {
  boardId: "hall.general",
  kind: "general",
  title: "General",
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
  messageCount: 3,
};

const taskBoard: CommunicationBoard = {
  boardId: "task:task-1",
  kind: "task",
  title: "Discussion: Fix the bug",
  taskId: "task-1",
  projectId: "project-1",
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:05:00.000Z",
  messageCount: 1,
};

describe("BoardList", () => {
  it("shows a loading message when loading with no boards yet", () => {
    render(
      <BoardList
        state="loading"
        boards={[]}
        selectedBoardId={null}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("Loading boards…")).toBeInTheDocument();
  });

  it("shows an empty state when ready with no boards", () => {
    render(
      <BoardList
        state="ready"
        boards={[]}
        selectedBoardId={null}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("No boards yet.")).toBeInTheDocument();
  });

  it("renders General first, then task boards, in the given (server) order", () => {
    render(
      <BoardList
        state="ready"
        boards={[generalBoard, taskBoard]}
        selectedBoardId={null}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("General");
    expect(items[1]).toHaveTextContent("Discussion: Fix the bug");
  });

  it("shows message count and project ID for a task board", () => {
    render(
      <BoardList
        state="ready"
        boards={[taskBoard]}
        selectedBoardId={null}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("project-1")).toBeInTheDocument();
    expect(screen.getByText("1 message")).toBeInTheDocument();
  });

  it("marks the selected board with aria-current", () => {
    render(
      <BoardList
        state="ready"
        boards={[generalBoard, taskBoard]}
        selectedBoardId="hall.general"
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /General/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Fix the bug/ })).not.toHaveAttribute("aria-current");
  });

  it("is keyboard-selectable: Tab to a board, Enter/click selects it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <BoardList
        state="ready"
        boards={[generalBoard, taskBoard]}
        selectedBoardId={null}
        onSelect={onSelect}
        onRefresh={vi.fn()}
      />,
    );
    const taskBoardButton = screen.getByRole("button", { name: /Fix the bug/ });
    taskBoardButton.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("task:task-1");
  });

  it("calls onRefresh when Refresh is clicked", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(
      <BoardList
        state="ready"
        boards={[generalBoard]}
        selectedBoardId={null}
        onSelect={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps existing boards visible and shows a warning on a refresh failure", () => {
    render(
      <BoardList
        state="error"
        boards={[generalBoard]}
        selectedBoardId={null}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText(/Could not refresh boards/)).toBeInTheDocument();
  });

  it("does not display the board ID as the primary visible label", () => {
    render(
      <BoardList
        state="ready"
        boards={[taskBoard]}
        selectedBoardId={null}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: /Fix the bug/ });
    // The primary label (first visible text) is the title, not the boardId.
    expect(button.textContent.trimStart().startsWith("Discussion: Fix the bug")).toBe(true);
    // The board ID is present only inside a collapsed <details> diagnostic.
    expect(screen.getByText("Board ID").closest("details")).not.toHaveAttribute("open");
  });
});
