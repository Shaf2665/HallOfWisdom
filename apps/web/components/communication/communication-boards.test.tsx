import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as apiClient from "../../lib/api-client";
import type { CommunicationBoard } from "../../lib/api-schemas";
import { CommunicationBoards } from "./communication-boards";

vi.mock("../../lib/api-client", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api-client")>("../../lib/api-client");
  return { ...actual, listBoards: vi.fn(), createBoardMessage: vi.fn() };
});

const mockRouter = { push: vi.fn(), replace: vi.fn() };
let mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(): void {
    // never called
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
}

const BASE_URL = "http://127.0.0.1:4310";
const WS_BASE_URL = "ws://127.0.0.1:4310";

const generalBoard: CommunicationBoard = {
  boardId: "hall.general",
  kind: "general",
  title: "General",
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
  messageCount: 0,
};

const taskBoard: CommunicationBoard = {
  boardId: "task:task-1",
  kind: "task",
  title: "Discussion: Fix the bug",
  taskId: "task-1",
  projectId: "project-1",
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:05:00.000Z",
  messageCount: 2,
};

describe("CommunicationBoards", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mockSearchParams = new URLSearchParams();
    mockRouter.push.mockReset();
    mockRouter.replace.mockReset();
    vi.mocked(apiClient.listBoards).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the page heading and local-only note", async () => {
    vi.mocked(apiClient.listBoards).mockResolvedValueOnce({ boards: [generalBoard] });
    render(<CommunicationBoards baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    expect(screen.getByRole("heading", { name: "Communication Boards" })).toBeInTheDocument();
    expect(screen.getByText(/cleared when Hall Core restarts/)).toBeInTheDocument();
    await screen.findByRole("heading", { name: "General", level: 3 });
  });

  it("selects General by default (it is always first)", async () => {
    vi.mocked(apiClient.listBoards).mockResolvedValueOnce({
      boards: [generalBoard, taskBoard],
    });
    render(<CommunicationBoards baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    await screen.findByRole("heading", { name: "General", level: 3 });
  });

  it("selects the board named by the boardId query parameter when present", async () => {
    mockSearchParams = new URLSearchParams({ boardId: "task:task-1" });
    vi.mocked(apiClient.listBoards).mockResolvedValueOnce({
      boards: [generalBoard, taskBoard],
    });
    render(<CommunicationBoards baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    await screen.findByRole("heading", { name: "Discussion: Fix the bug", level: 3 });
  });

  it("shows an empty state before any board has loaded", () => {
    vi.mocked(apiClient.listBoards).mockReturnValueOnce(new Promise(() => undefined));
    render(<CommunicationBoards baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    expect(screen.getAllByText("Loading boards…").length).toBeGreaterThan(0);
  });

  it("keeps existing boards visible when a refresh fails", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listBoards).mockResolvedValueOnce({ boards: [generalBoard] });
    render(<CommunicationBoards baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    await screen.findByRole("heading", { name: "General", level: 3 });

    vi.mocked(apiClient.listBoards).mockRejectedValueOnce(new Error("network down"));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(screen.getByText(/Could not refresh boards/)).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "General", level: 3 })).toBeInTheDocument();
  });

  it("selecting a board via keyboard updates the URL via router.replace", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.listBoards).mockResolvedValueOnce({
      boards: [generalBoard, taskBoard],
    });
    render(<CommunicationBoards baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    const taskBoardButton = await screen.findByRole("button", { name: /Fix the bug/ });
    taskBoardButton.focus();
    await user.keyboard("{Enter}");
    expect(mockRouter.replace).toHaveBeenCalledWith(
      `/boards?boardId=${encodeURIComponent("task:task-1")}`,
    );
  });

  it("shows a connection status indicator for the selected board", async () => {
    vi.mocked(apiClient.listBoards).mockResolvedValueOnce({ boards: [generalBoard] });
    render(<CommunicationBoards baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    await screen.findByRole("heading", { name: "General", level: 3 });
    // Connecting, then connected once the fake socket opens. Awaited via
    // waitFor: the board-selection heading and the WebSocket hook's own
    // "idle" -> "connecting" transition land in separate effect passes, so
    // asserting immediately after the heading appears can race ahead of it.
    await waitFor(() => {
      expect(screen.getByText(/Connecting|Live/)).toBeInTheDocument();
    });
  });

  it("offers a manual Reconnect control once disconnected", async () => {
    vi.mocked(apiClient.listBoards).mockResolvedValueOnce({ boards: [generalBoard] });
    render(<CommunicationBoards baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />);
    await screen.findByRole("heading", { name: "General", level: 3 });
    const socket = FakeWebSocket.instances.at(-1);
    socket?.onclose?.({ code: 4400, reason: "" });
    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("has no page-level layout that would require horizontal scrolling at a narrow width (uses grid-cols-1 by default)", async () => {
    vi.mocked(apiClient.listBoards).mockResolvedValueOnce({ boards: [generalBoard] });
    const { container } = render(
      <CommunicationBoards baseUrl={BASE_URL} wsBaseUrl={WS_BASE_URL} />,
    );
    await screen.findByRole("heading", { name: "General", level: 3 });
    const grid = container.querySelector(".grid");
    expect(grid).toHaveClass("grid-cols-1");
  });
});
