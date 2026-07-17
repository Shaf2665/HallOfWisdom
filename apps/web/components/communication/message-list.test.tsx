import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CommunicationMessage } from "@hall-of-wisdom/protocol";
import { MessageList } from "./message-list";

function makeMessage(overrides: Partial<CommunicationMessage> = {}): CommunicationMessage {
  return {
    messageId: "msg-1",
    boardId: "hall.general",
    sequence: 0,
    author: { kind: "human", displayName: "Local Operator" },
    text: "hello there",
    createdAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("MessageList", () => {
  it("shows an empty state when there are no messages", () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByText("No messages yet. Start the discussion.")).toBeInTheDocument();
  });

  it("renders the author display name and text", () => {
    render(<MessageList messages={[makeMessage()]} />);
    expect(screen.getByText("Local Operator")).toBeInTheDocument();
    expect(screen.getByText("hello there")).toBeInTheDocument();
  });

  it("shows the sequence number as diagnostic text", () => {
    render(<MessageList messages={[makeMessage({ sequence: 5 })]} />);
    expect(screen.getByText("#5")).toBeInTheDocument();
  });

  it("preserves line breaks by rendering them as plain text with white-space preserved", () => {
    render(<MessageList messages={[makeMessage({ text: "line one\nline two" })]} />);
    const paragraph = screen.getByText(
      (_, element) => element?.textContent === "line one\nline two",
    );
    expect(paragraph).toHaveClass("whitespace-pre-wrap");
  });

  it("never executes HTML-like content — it is rendered as literal text", () => {
    const maliciousText = "<img src=x onerror=alert(1)>";
    render(<MessageList messages={[makeMessage({ text: maliciousText })]} />);
    expect(screen.getByText(maliciousText)).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });

  it("never creates an automatic link from URL-like text", () => {
    render(<MessageList messages={[makeMessage({ text: "visit http://example.com now" })]} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders multiple messages in the given order", () => {
    const messages = [
      makeMessage({ messageId: "m0", sequence: 0, text: "first" }),
      makeMessage({ messageId: "m1", sequence: 1, text: "second" }),
    ];
    render(<MessageList messages={messages} />);
    const rendered = screen.getAllByText(/first|second/);
    expect(rendered.map((el) => el.textContent)).toEqual(["first", "second"]);
  });
});
