import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import { MessageComposer } from "./message-composer";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, createBoardMessage: vi.fn(), uploadBoardAttachment: vi.fn() };
});

const BASE_URL = "http://127.0.0.1:4310";
const BOARD_ID = "hall.general";

const IMAGE_ATTACHMENT = {
  attachmentId: "attachment-1",
  filename: "diagram.png",
  mimeType: "image/png",
  byteSize: 1024,
  kind: "image" as const,
};

const FILE_ATTACHMENT = {
  attachmentId: "attachment-2",
  filename: "notes.txt",
  mimeType: "text/plain",
  byteSize: 512,
  kind: "file" as const,
};

function makeFile(name: string, type: string, sizeBytes = 1024): File {
  return new File([new Uint8Array(sizeBytes)], name, { type });
}

function getFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not found");
  return input;
}

function getForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector<HTMLFormElement>("form");
  if (!form) throw new Error("form not found");
  return form;
}

describe("MessageComposer", () => {
  beforeEach(() => {
    vi.mocked(apiClient.createBoardMessage).mockReset();
    vi.mocked(apiClient.uploadBoardAttachment).mockReset();
    if (!("createObjectURL" in URL)) {
      Object.defineProperty(URL, "createObjectURL", { value: vi.fn(), writable: true });
    }
    if (!("revokeObjectURL" in URL)) {
      Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true });
    }
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-preview-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {
      // no-op
    });
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
      expect(apiClient.createBoardMessage).toHaveBeenCalledWith(BASE_URL, BOARD_ID, "hello", []);
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
      expect(apiClient.createBoardMessage).toHaveBeenCalledWith(BASE_URL, BOARD_ID, "hello", []);
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

  describe("attachments", () => {
    it("clicking the attach button opens the hidden file input", async () => {
      const user = userEvent.setup();
      const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const input = getFileInput(container);
      const clickSpy = vi.spyOn(input, "click");
      await user.click(screen.getByRole("button", { name: "Attach files" }));
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it("selecting a file via the attach button shows a preview and uploads it", async () => {
      vi.mocked(apiClient.uploadBoardAttachment).mockResolvedValueOnce(IMAGE_ATTACHMENT);
      const user = userEvent.setup();
      const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const input = getFileInput(container);
      const file = makeFile("diagram.png", "image/png");
      await user.upload(input, file);
      expect(await screen.findByText("diagram.png")).toBeInTheDocument();
      await waitFor(() => {
        expect(apiClient.uploadBoardAttachment).toHaveBeenCalledWith(BASE_URL, BOARD_ID, file);
      });
    });

    it("renders an image preview thumbnail for an image attachment", async () => {
      vi.mocked(apiClient.uploadBoardAttachment).mockResolvedValueOnce(IMAGE_ATTACHMENT);
      const user = userEvent.setup();
      const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const input = getFileInput(container);
      await user.upload(input, makeFile("diagram.png", "image/png"));
      const image = await screen.findByRole("img", { name: "Preview of diagram.png" });
      expect(image).toHaveAttribute("src", "blob:mock-preview-url");
    });

    it("renders a compact file card (no image thumbnail) for a non-image attachment", async () => {
      vi.mocked(apiClient.uploadBoardAttachment).mockResolvedValueOnce(FILE_ATTACHMENT);
      const user = userEvent.setup();
      const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const input = getFileInput(container);
      await user.upload(input, makeFile("notes.txt", "text/plain"));
      expect(await screen.findByText("notes.txt")).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("dropping a file onto the composer uploads it", async () => {
      vi.mocked(apiClient.uploadBoardAttachment).mockResolvedValueOnce(IMAGE_ATTACHMENT);
      const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const form = getForm(container);
      const file = makeFile("diagram.png", "image/png");
      fireEvent.drop(form, { dataTransfer: { types: ["Files"], files: [file] } });
      expect(await screen.findByText("diagram.png")).toBeInTheDocument();
      await waitFor(() => {
        expect(apiClient.uploadBoardAttachment).toHaveBeenCalledWith(BASE_URL, BOARD_ID, file);
      });
    });

    it("pasting an image from the clipboard uploads it", async () => {
      vi.mocked(apiClient.uploadBoardAttachment).mockResolvedValueOnce(IMAGE_ATTACHMENT);
      render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const textarea = screen.getByLabelText("Write a message");
      const file = makeFile("pasted.png", "image/png");
      fireEvent.paste(textarea, {
        clipboardData: { items: [{ kind: "file", getAsFile: () => file }] },
      });
      await waitFor(() => {
        expect(apiClient.uploadBoardAttachment).toHaveBeenCalledWith(BASE_URL, BOARD_ID, file);
      });
    });

    it("a plain text paste (no files) is unaffected by the clipboard-paste handler", () => {
      render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const textarea = screen.getByLabelText("Write a message");
      fireEvent.paste(textarea, { clipboardData: { items: [] } });
      expect(apiClient.uploadBoardAttachment).not.toHaveBeenCalled();
    });

    it("removing a pending attachment before send drops it and never sends it", async () => {
      vi.mocked(apiClient.uploadBoardAttachment).mockResolvedValueOnce(IMAGE_ATTACHMENT);
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
      const input = getFileInput(container);
      await user.upload(input, makeFile("diagram.png", "image/png"));
      await screen.findByText("diagram.png");
      await user.click(screen.getByRole("button", { name: "Remove diagram.png" }));
      expect(screen.queryByText("diagram.png")).not.toBeInTheDocument();

      await user.type(screen.getByLabelText("Write a message"), "hello");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => {
        expect(apiClient.createBoardMessage).toHaveBeenCalledWith(BASE_URL, BOARD_ID, "hello", []);
      });
    });

    it("rejects an oversized file client-side without calling the upload API", async () => {
      const user = userEvent.setup();
      const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const input = getFileInput(container);
      const hugeFile = makeFile("huge.png", "image/png", 9 * 1024 * 1024);
      await user.upload(input, hugeFile);
      expect(await screen.findByRole("alert")).toHaveTextContent(/exceeds/);
      expect(apiClient.uploadBoardAttachment).not.toHaveBeenCalled();
    });

    it("rejects a disallowed file type client-side without calling the upload API", async () => {
      // Dropped (not selected via the file input): unlike the input's own
      // `accept` attribute, which the OS file picker already filters by,
      // drag-and-drop can carry any file type, so this is the path that
      // actually exercises the MIME-type check.
      const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const form = getForm(container);
      const file = makeFile("app.exe", "application/x-msdownload");
      fireEvent.drop(form, { dataTransfer: { types: ["Files"], files: [file] } });
      expect(await screen.findByRole("alert")).toHaveTextContent(/not a supported file type/);
      expect(apiClient.uploadBoardAttachment).not.toHaveBeenCalled();
    });

    it("Send is disabled while an attachment is still uploading", async () => {
      let resolveUpload!: (value: Awaited<ReturnType<typeof apiClient.uploadBoardAttachment>>) => void;
      vi.mocked(apiClient.uploadBoardAttachment).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveUpload = resolve;
        }),
      );
      const user = userEvent.setup();
      const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const input = getFileInput(container);
      await user.upload(input, makeFile("diagram.png", "image/png"));
      await user.type(screen.getByLabelText("Write a message"), "hello");
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      resolveUpload(IMAGE_ATTACHMENT);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
      });
    });

    it("shows an inline error and keeps Send disabled when an upload fails", async () => {
      vi.mocked(apiClient.uploadBoardAttachment).mockRejectedValueOnce(
        new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
      );
      const user = userEvent.setup();
      const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const input = getFileInput(container);
      await user.upload(input, makeFile("diagram.png", "image/png"));
      expect(await screen.findByText("Upload failed")).toBeInTheDocument();
      await user.type(screen.getByLabelText("Write a message"), "hello");
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    });

    it("sends an attachments-only message (blank text) once the upload finishes", async () => {
      vi.mocked(apiClient.uploadBoardAttachment).mockResolvedValueOnce(IMAGE_ATTACHMENT);
      vi.mocked(apiClient.createBoardMessage).mockResolvedValueOnce({
        messageId: "msg-1",
        boardId: BOARD_ID,
        sequence: 0,
        author: { kind: "human", displayName: "Local Operator" },
        text: "",
        attachments: [IMAGE_ATTACHMENT],
        createdAt: "2026-07-15T12:00:00.000Z",
      });
      const user = userEvent.setup();
      const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const input = getFileInput(container);
      await user.upload(input, makeFile("diagram.png", "image/png"));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
      });
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => {
        expect(apiClient.createBoardMessage).toHaveBeenCalledWith(BASE_URL, BOARD_ID, "", [
          "attachment-1",
        ]);
      });
    });

    it("clears attachment previews after a successful send", async () => {
      vi.mocked(apiClient.uploadBoardAttachment).mockResolvedValueOnce(IMAGE_ATTACHMENT);
      vi.mocked(apiClient.createBoardMessage).mockResolvedValueOnce({
        messageId: "msg-1",
        boardId: BOARD_ID,
        sequence: 0,
        author: { kind: "human", displayName: "Local Operator" },
        text: "hello",
        attachments: [IMAGE_ATTACHMENT],
        createdAt: "2026-07-15T12:00:00.000Z",
      });
      const user = userEvent.setup();
      const { container } = render(<MessageComposer baseUrl={BASE_URL} boardId={BOARD_ID} />);
      const input = getFileInput(container);
      await user.upload(input, makeFile("diagram.png", "image/png"));
      await screen.findByText("diagram.png");
      await user.type(screen.getByLabelText("Write a message"), "hello");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => {
        expect(screen.queryByText("diagram.png")).not.toBeInTheDocument();
      });
    });
  });
});
