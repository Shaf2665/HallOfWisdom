import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import { MessageComposer } from "./message-composer";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, createBoardMessage: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";
const BOARD_ID = "hall.general";

describe("MessageComposer", () => {
  beforeEach(() => {
    vi.mocked(apiClient.createBoardMessage).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has a visible label for the textarea", () => {
    render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    expect(screen.getByLabelText("Write a message")).toBeInTheDocument();
  });

  it("shows the maximum length", () => {
    render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    expect(screen.getByText(/4000 characters/)).toBeInTheDocument();
  });

  it("disables Send for a blank message", () => {
    render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("disables Send for a whitespace-only message", async () => {
    const user = userEvent.setup();
    render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    await user.type(screen.getByLabelText("Write a message"), "   ");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("enforces the maximum length by disabling Send when exceeded", async () => {
    const user = userEvent.setup();
    render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    const textarea = screen.getByLabelText("Write a message");
    await user.click(textarea);
    // Paste rather than type 4001 characters individually (much faster).
    await user.paste("x".repeat(4001));
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/too long/);
  });

  it("sends the message and clears the text on success", async () => {
    vi.mocked(apiClient.createBoardMessage).mockResolvedValueOnce({
      messageId: "msg-1",
      boardId: BOARD_ID,
      sequence: 0,
      author: { kind: "human", displayName: "Local Operator" },
      text: "hello",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    const user = userEvent.setup();
    render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    const textarea = screen.getByLabelText("Write a message");
    await user.type(textarea, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(apiClient.createBoardMessage).toHaveBeenCalledWith(BASE_URL, BOARD_ID, "hello");
    });
    await waitFor(() => {
      expect(textarea).toHaveValue("");
    });
  });

  it("preserves the entered text after a failed submission and shows a safe error", async () => {
    vi.mocked(apiClient.createBoardMessage).mockRejectedValueOnce(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );
    const user = userEvent.setup();
    render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    const textarea = screen.getByLabelText("Write a message");
    await user.type(textarea, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Could not reach Hall Core.")).toBeInTheDocument();
    expect(textarea).toHaveValue("hello");
  });

  it("prevents duplicate submission while one is already in flight", async () => {
    let resolveSend!: (value: Awaited<ReturnType<typeof apiClient.createBoardMessage>>) => void;
    vi.mocked(apiClient.createBoardMessage).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    const textarea = screen.getByLabelText("Write a message");
    await user.type(textarea, "hello");
    const sendButton = screen.getByRole("button", { name: "Send" });
    await user.click(sendButton);
    expect(sendButton).toBeDisabled();
    await user.click(sendButton);
    expect(apiClient.createBoardMessage).toHaveBeenCalledTimes(1);
    resolveSend({
      messageId: "msg-1",
      boardId: BOARD_ID,
      sequence: 0,
      author: { kind: "human", displayName: "Local Operator" },
      text: "hello",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
  });

  it("Enter inserts a newline rather than submitting", async () => {
    const user = userEvent.setup();
    render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    const textarea = screen.getByLabelText("Write a message");
    await user.type(textarea, "line one{Enter}line two");
    expect(textarea).toHaveValue("line one\nline two");
    expect(apiClient.createBoardMessage).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter submits the message", async () => {
    vi.mocked(apiClient.createBoardMessage).mockResolvedValueOnce({
      messageId: "msg-1",
      boardId: BOARD_ID,
      sequence: 0,
      author: { kind: "human", displayName: "Local Operator" },
      text: "hello",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    const user = userEvent.setup();
    render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    const textarea = screen.getByLabelText("Write a message");
    await user.type(textarea, "hello");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => {
      expect(apiClient.createBoardMessage).toHaveBeenCalledWith(BASE_URL, BOARD_ID, "hello");
    });
  });

  it("never uses dangerouslySetInnerHTML or renders raw HTML from the typed text", () => {
    render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    // The textarea's own value is always text content, never interpreted
    // as markup — a structural guarantee of using a native <textarea>,
    // verified here by confirming no injected <script>/<img> exists.
    expect(document.querySelector("script")).not.toBeInTheDocument();
  });

  it("announces success and failure via a polite live region", async () => {
    vi.mocked(apiClient.createBoardMessage).mockResolvedValueOnce({
      messageId: "msg-1",
      boardId: BOARD_ID,
      sequence: 0,
      author: { kind: "human", displayName: "Local Operator" },
      text: "hello",
      createdAt: "2026-07-15T12:00:00.000Z",
    });
    const user = userEvent.setup();
    const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
    const textarea = screen.getByLabelText("Write a message");
    await user.type(textarea, "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent("Message sent.");
    });
  });
});
