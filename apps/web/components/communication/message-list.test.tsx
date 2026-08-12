import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CommunicationMessage, MessageAttachment } from "@hall-of-wisdom/protocol";
import { MessageList } from "./message-list";

const BASE_URL = "http://127.0.0.1:4310";

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

const IMAGE_ATTACHMENT: MessageAttachment = {
  attachmentId: "attachment-1",
  filename: "diagram.png",
  mimeType: "image/png",
  byteSize: 1024,
  kind: "image",
};

const FILE_ATTACHMENT: MessageAttachment = {
  attachmentId: "attachment-2",
  filename: "notes.txt",
  mimeType: "text/plain",
  byteSize: 512,
  kind: "file",
};

describe("MessageList", () => {
  it("shows an empty state when there are no messages", () => {
    render(<MessageList baseUrl={BASE_URL} messages={[]} />);
    expect(screen.getByText("No messages yet. Start the discussion.")).toBeInTheDocument();
  });

  it("renders the author display name and text", () => {
    render(<MessageList baseUrl={BASE_URL} messages={[makeMessage()]} />);
    expect(screen.getByText("Local Operator")).toBeInTheDocument();
    expect(screen.getByText("hello there")).toBeInTheDocument();
  });

  it("shows the sequence number as diagnostic text", () => {
    render(<MessageList baseUrl={BASE_URL} messages={[makeMessage({ sequence: 5 })]} />);
    expect(screen.getByText("#5")).toBeInTheDocument();
  });

  it("preserves line breaks by rendering them as plain text with white-space preserved", () => {
    render(
      <MessageList baseUrl={BASE_URL} messages={[makeMessage({ text: "line one\nline two" })]} />,
    );
    const paragraph = screen.getByText(
      (_, element) => element?.textContent === "line one\nline two",
    );
    expect(paragraph).toHaveClass("whitespace-pre-wrap");
  });

  it("never executes HTML-like content — it is rendered as literal text", () => {
    const maliciousText = "<img src=x onerror=alert(1)>";
    render(<MessageList baseUrl={BASE_URL} messages={[makeMessage({ text: maliciousText })]} />);
    expect(screen.getByText(maliciousText)).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });

  it("never creates an automatic link from URL-like text", () => {
    render(
      <MessageList
        baseUrl={BASE_URL}
        messages={[makeMessage({ text: "visit http://example.com now" })]}
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders multiple messages in the given order", () => {
    const messages = [
      makeMessage({ messageId: "m0", sequence: 0, text: "first" }),
      makeMessage({ messageId: "m1", sequence: 1, text: "second" }),
    ];
    render(<MessageList baseUrl={BASE_URL} messages={messages} />);
    const rendered = screen.getAllByText(/first|second/);
    expect(rendered.map((el) => el.textContent)).toEqual(["first", "second"]);
  });

  it("a message without an attachments key renders identically to before (regression)", () => {
    render(<MessageList baseUrl={BASE_URL} messages={[makeMessage()]} />);
    expect(document.querySelector("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /diagram|notes/ })).not.toBeInTheDocument();
  });

  describe("attachments", () => {
    it("renders an image attachment as a thumbnail pointing at the attachments GET endpoint", () => {
      render(
        <MessageList
          baseUrl={BASE_URL}
          messages={[makeMessage({ text: "see attached", attachments: [IMAGE_ATTACHMENT] })]}
        />,
      );
      const image = screen.getByRole("img", { name: "diagram.png" });
      expect(image).toHaveAttribute(
        "src",
        `${BASE_URL}/api/v1/boards/hall.general/attachments/attachment-1`,
      );
    });

    it("renders a non-image attachment as a filename/size card with a download link", () => {
      render(
        <MessageList
          baseUrl={BASE_URL}
          messages={[makeMessage({ text: "", attachments: [FILE_ATTACHMENT] })]}
        />,
      );
      expect(screen.getByText("notes.txt")).toBeInTheDocument();
      expect(screen.getByText("512 B")).toBeInTheDocument();
      const link = screen.getByText("notes.txt").closest("a");
      expect(link).toHaveAttribute(
        "href",
        `${BASE_URL}/api/v1/boards/hall.general/attachments/attachment-2`,
      );
      expect(link).toHaveAttribute("download", "notes.txt");
    });

    it("renders multiple attachments on one message", () => {
      render(
        <MessageList
          baseUrl={BASE_URL}
          messages={[
            makeMessage({ text: "two files", attachments: [IMAGE_ATTACHMENT, FILE_ATTACHMENT] }),
          ]}
        />,
      );
      expect(screen.getByRole("img", { name: "diagram.png" })).toBeInTheDocument();
      expect(screen.getByText("notes.txt")).toBeInTheDocument();
    });

    it("renders an attachments-only message (blank text) without an empty text paragraph", () => {
      render(
        <MessageList
          baseUrl={BASE_URL}
          messages={[makeMessage({ text: "", attachments: [IMAGE_ATTACHMENT] })]}
        />,
      );
      expect(screen.getByRole("img", { name: "diagram.png" })).toBeInTheDocument();
      expect(screen.queryByText("hello there")).not.toBeInTheDocument();
    });
  });
});
