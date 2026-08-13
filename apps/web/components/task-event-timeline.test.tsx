import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { TaskEventTimeline } from "./task-event-timeline";

function makeEvent(
  sequence: number,
  overrides: Partial<NormalizedAgentEvent> = {},
): NormalizedAgentEvent {
  return {
    protocolVersion: "0.1",
    eventId: `event-${String(sequence)}`,
    runId: "run-1",
    taskId: "task-1",
    agentId: "agent-1",
    timestamp: new Date().toISOString(),
    sequence,
    type: "message.delta",
    payload: { text: "progress" },
    ...overrides,
  } as NormalizedAgentEvent;
}

describe("TaskEventTimeline", () => {
  it("renders run.failed events with the red terminal-error style, not amber", () => {
    const failed = makeEvent(0, {
      type: "run.failed",
      payload: { failure: { code: "ADAPTER_ERROR", message: "boom" } },
    });
    render(<TaskEventTimeline events={[failed]} />);

    const row = screen.getByText(/Task failed/).closest("li");
    expect(row?.className).toContain("border-red-300");
    expect(row?.className).not.toContain("border-amber-300");
  });

  it("still renders other terminal events (run.completed) with the amber style", () => {
    const completed = makeEvent(0, { type: "run.completed", payload: {} });
    render(<TaskEventTimeline events={[completed]} />);

    const row = screen.getByText("Task completed").closest("li");
    expect(row?.className).toContain("border-amber-300");
    expect(row?.className).not.toContain("border-red-300");
  });

  it("renders non-terminal events with the default style", () => {
    const delta = makeEvent(0);
    render(<TaskEventTimeline events={[delta]} />);

    const row = screen.getByText("progress").closest("li");
    expect(row?.className).toContain("border-stone-200");
  });
});
