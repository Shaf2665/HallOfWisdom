import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../lib/api-client";
import type { CreateTaskResponse } from "../lib/api-schemas";
import { WisdomGateway } from "./wisdom-gateway";

vi.mock("./gateway-overview", () => ({
  GatewayOverview: () => null,
}));

vi.mock("../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../lib/api-client")>("../lib/api-client");
  return {
    ...actual,
    listTasks: vi.fn(),
    listCeoPlans: vi.fn(),
    createDeferredTask: vi.fn(),
    ensureTaskBoard: vi.fn(),
    uploadBoardAttachment: vi.fn(),
    createBoardMessage: vi.fn(),
    createCeoPlan: vi.fn(),
    getCeoPlan: vi.fn(),
    getCeoPlanVersion: vi.fn(),
  };
});

const BASE_URL = "http://127.0.0.1:4310";
const WS_BASE_URL = "ws://127.0.0.1:4310";
const TASK_ID = "task-1";
const BOARD_ID = `task:${TASK_ID}`;

const IMAGE_ATTACHMENT = {
  attachmentId: "attachment-1",
  filename: "diagram.png",
  mimeType: "image/png",
  byteSize: 1024,
  kind: "image" as const,
};

function makeFile(name: string, type: string, sizeBytes = 1024): File {
  return new File([new Uint8Array(sizeBytes)], name, { type });
}

function getFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("file input not found");
  return input;
}

function getRequestForm(container: HTMLElement): HTMLFormElement {
  const form = container.querySelector<HTMLFormElement>("form");
  if (!form) throw new Error("form not found");
  return form;
}

function taskResponse(overrides: Partial<CreateTaskResponse["task"]> = {}): CreateTaskResponse {
  return {
    task: {
      taskId: TASK_ID,
      projectId: "project-1",
      title: "Do the thing",
      description: "Do the thing, please.",
      priority: "normal",
      status: "backlog",
      dependencyTaskIds: [],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
      source: "wisdom_gateway",
      ...overrides,
    },
    runId: undefined,
    adapterId: undefined,
    agentId: undefined,
    eventCount: 0,
    cancellationRequested: false,
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}

async function fillAndSubmitRequest(
  user: ReturnType<typeof userEvent.setup>,
  text = "Do the thing",
): Promise<void> {
  await user.type(screen.getByLabelText("Your request"), text);
  await user.click(screen.getByRole("button", { name: /Send to CEO/ }));
}

describe("WisdomGateway", () => {
  beforeEach(() => {
    vi.mocked(apiClient.listTasks).mockResolvedValue({ tasks: [] });
    vi.mocked(apiClient.listCeoPlans).mockResolvedValue({ plans: [] });
    vi.mocked(apiClient.createDeferredTask).mockReset().mockResolvedValue(taskResponse());
    vi.mocked(apiClient.ensureTaskBoard).mockReset();
    vi.mocked(apiClient.uploadBoardAttachment).mockReset();
    vi.mocked(apiClient.createBoardMessage).mockReset();
    vi.mocked(apiClient.createCeoPlan).mockReset();
    vi.mocked(apiClient.getCeoPlan).mockReset();
    vi.mocked(apiClient.getCeoPlanVersion).mockReset();
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

  async function selectAProject(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    const projectNameInput = await screen.findByLabelText("Project name");
    await user.type(projectNameInput, "project-1");
  }

  it("text-only submission is unchanged: creates the task and starts planning without touching the attachment endpoints", async () => {
    vi.mocked(apiClient.createCeoPlan).mockRejectedValue(new Error("no plan in this test"));
    const user = userEvent.setup();
    render(<WisdomGateway baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    await waitFor(() => {
      expect(apiClient.listTasks).toHaveBeenCalled();
    });
    await selectAProject(user);
    await fillAndSubmitRequest(user);

    await waitFor(() => {
      expect(apiClient.createDeferredTask).toHaveBeenCalledWith(BASE_URL, {
        projectId: "project-1",
        title: "Do the thing",
        description: "Do the thing",
        source: "wisdom_gateway",
      });
    });
    expect(apiClient.ensureTaskBoard).not.toHaveBeenCalled();
    expect(apiClient.uploadBoardAttachment).not.toHaveBeenCalled();
    expect(apiClient.createBoardMessage).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(apiClient.createCeoPlan).toHaveBeenCalledWith(BASE_URL, TASK_ID);
    });
  });

  it("clicking the attach button opens the hidden file input", async () => {
    const user = userEvent.setup();
    const { container } = render(<WisdomGateway baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    const input = getFileInput(container);
    const clickSpy = vi.spyOn(input, "click");
    await user.click(screen.getByRole("button", { name: "Attach files" }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("selecting a file via the attach button shows a preview and does not upload it yet", async () => {
    const user = userEvent.setup();
    const { container } = render(<WisdomGateway baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    const input = getFileInput(container);
    await user.upload(input, makeFile("diagram.png", "image/png"));
    expect(await screen.findByText("diagram.png")).toBeInTheDocument();
    expect(apiClient.uploadBoardAttachment).not.toHaveBeenCalled();
  });

  it("pasting an image into the request textarea stages it", async () => {
    const { container } = render(<WisdomGateway baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    const textarea = screen.getByLabelText("Your request");
    const file = makeFile("pasted.png", "image/png");
    fireEvent.paste(textarea, {
      clipboardData: { items: [{ kind: "file", getAsFile: () => file }] },
    });
    expect(await screen.findByText("pasted.png")).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });

  it("dropping a file onto the form stages it", async () => {
    const { container } = render(<WisdomGateway baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    const form = getRequestForm(container);
    const file = makeFile("diagram.png", "image/png");
    fireEvent.drop(form, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(await screen.findByText("diagram.png")).toBeInTheDocument();
  });

  it("removing a staged attachment before send drops it and it is never uploaded", async () => {
    const user = userEvent.setup();
    const { container } = render(<WisdomGateway baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    const input = getFileInput(container);
    await user.upload(input, makeFile("diagram.png", "image/png"));
    await screen.findByText("diagram.png");
    await user.click(screen.getByRole("button", { name: "Remove diagram.png" }));
    expect(screen.queryByText("diagram.png")).not.toBeInTheDocument();

    vi.mocked(apiClient.createCeoPlan).mockRejectedValue(new Error("no plan in this test"));
    await selectAProject(user);
    await fillAndSubmitRequest(user);
    await waitFor(() => {
      expect(apiClient.createDeferredTask).toHaveBeenCalled();
    });
    expect(apiClient.ensureTaskBoard).not.toHaveBeenCalled();
    expect(apiClient.uploadBoardAttachment).not.toHaveBeenCalled();
  });

  it("rejects an oversized file client-side without staging it", async () => {
    const user = userEvent.setup();
    const { container } = render(<WisdomGateway baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    const input = getFileInput(container);
    const hugeFile = makeFile("huge.png", "image/png", 9 * 1024 * 1024);
    await user.upload(input, hugeFile);
    expect(await screen.findByRole("alert")).toHaveTextContent(/exceeds/);
    expect(screen.queryByText("huge.png")).not.toBeInTheDocument();
  });

  it("creates the parent task, then ensures its board, uploads staged attachments, and posts a human message linking them, before planning starts", async () => {
    vi.mocked(apiClient.ensureTaskBoard).mockResolvedValue({
      board: {
        boardId: BOARD_ID,
        kind: "task",
        taskId: TASK_ID,
        title: "Do the thing",
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
        messageCount: 0,
      },
      messagesPath: `/api/v1/boards/${BOARD_ID}/messages`,
      livePath: `/ws/boards/${BOARD_ID}`,
    });
    vi.mocked(apiClient.uploadBoardAttachment).mockResolvedValue(IMAGE_ATTACHMENT);
    vi.mocked(apiClient.createBoardMessage).mockResolvedValue({
      messageId: "msg-1",
      boardId: BOARD_ID,
      sequence: 0,
      author: { kind: "human", displayName: "Local Operator" },
      text: "Do the thing",
      attachments: [IMAGE_ATTACHMENT],
      createdAt: "2026-08-15T00:00:00.000Z",
    });
    vi.mocked(apiClient.createCeoPlan).mockRejectedValue(new Error("no plan in this test"));

    const user = userEvent.setup();
    const { container } = render(<WisdomGateway baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    const input = getFileInput(container);
    await user.upload(input, makeFile("diagram.png", "image/png"));
    await screen.findByText("diagram.png");
    await selectAProject(user);
    await fillAndSubmitRequest(user);

    await waitFor(() => {
      expect(apiClient.createDeferredTask).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(apiClient.ensureTaskBoard).toHaveBeenCalledWith(BASE_URL, TASK_ID);
    });
    expect(apiClient.uploadBoardAttachment).toHaveBeenCalledWith(
      BASE_URL,
      BOARD_ID,
      expect.objectContaining({ name: "diagram.png" }),
    );
    expect(apiClient.createBoardMessage).toHaveBeenCalledWith(BASE_URL, BOARD_ID, "Do the thing", [
      "attachment-1",
    ]);

    // Planning only starts once the attachment linking above has resolved —
    // proven by call order, not just "eventually called."
    const uploadOrder = vi.mocked(apiClient.uploadBoardAttachment).mock.invocationCallOrder[0];
    const messageOrder = vi.mocked(apiClient.createBoardMessage).mock.invocationCallOrder[0];
    await waitFor(() => {
      expect(apiClient.createCeoPlan).toHaveBeenCalled();
    });
    const planOrder = vi.mocked(apiClient.createCeoPlan).mock.invocationCallOrder[0];
    expect(uploadOrder).toBeDefined();
    expect(messageOrder).toBeDefined();
    expect(planOrder).toBeDefined();
    expect(uploadOrder ?? 0).toBeLessThan(messageOrder ?? 0);
    expect(messageOrder ?? 0).toBeLessThan(planOrder ?? 0);
  });

  it("does not start planning and shows a clear error when attachment upload fails", async () => {
    vi.mocked(apiClient.ensureTaskBoard).mockResolvedValue({
      board: {
        boardId: BOARD_ID,
        kind: "task",
        taskId: TASK_ID,
        title: "Do the thing",
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
        messageCount: 0,
      },
      messagesPath: `/api/v1/boards/${BOARD_ID}/messages`,
      livePath: `/ws/boards/${BOARD_ID}`,
    });
    vi.mocked(apiClient.uploadBoardAttachment).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );

    const user = userEvent.setup();
    const { container } = render(<WisdomGateway baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    const input = getFileInput(container);
    await user.upload(input, makeFile("diagram.png", "image/png"));
    await screen.findByText("diagram.png");
    await selectAProject(user);
    await fillAndSubmitRequest(user);

    await waitFor(() => {
      expect(apiClient.uploadBoardAttachment).toHaveBeenCalled();
    });
    expect(apiClient.createBoardMessage).not.toHaveBeenCalled();
    expect(apiClient.createCeoPlan).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/attachments couldn.t be uploaded, so planning didn.t start/),
    ).toBeInTheDocument();
  });

  it("does not start planning and shows a clear error when linking the board message fails", async () => {
    vi.mocked(apiClient.ensureTaskBoard).mockResolvedValue({
      board: {
        boardId: BOARD_ID,
        kind: "task",
        taskId: TASK_ID,
        title: "Do the thing",
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
        messageCount: 0,
      },
      messagesPath: `/api/v1/boards/${BOARD_ID}/messages`,
      livePath: `/ws/boards/${BOARD_ID}`,
    });
    vi.mocked(apiClient.uploadBoardAttachment).mockResolvedValue(IMAGE_ATTACHMENT);
    vi.mocked(apiClient.createBoardMessage).mockRejectedValue(
      new apiClient.ApiClientError("NETWORK_ERROR", "Could not reach Hall Core."),
    );

    const user = userEvent.setup();
    const { container } = render(<WisdomGateway baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    const input = getFileInput(container);
    await user.upload(input, makeFile("diagram.png", "image/png"));
    await screen.findByText("diagram.png");
    await selectAProject(user);
    await fillAndSubmitRequest(user);

    await waitFor(() => {
      expect(apiClient.createBoardMessage).toHaveBeenCalled();
    });
    expect(apiClient.createCeoPlan).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/attachments couldn.t be uploaded, so planning didn.t start/),
    ).toBeInTheDocument();
  });
});
