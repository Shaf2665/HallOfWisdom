import { afterEach, describe, expect, it, vi } from "vitest";
import { installShutdownSignals, STDIN_SHUTDOWN_COMMAND } from "./signal-shutdown.js";

/**
 * Triggered via `process.emit(signal, signal)` rather than a real OS
 * signal — the same, deliberately safe approach used by Hall Runner's
 * `signal-cancellation.test.ts` (`runners/hall-runner/src/signal-cancellation.test.ts`).
 * `process.emit` synchronously invokes already-registered listeners
 * without engaging the operating system's signal delivery, so it can
 * never terminate the Vitest worker process.
 */
function emit(signal: "SIGINT" | "SIGTERM"): void {
  process.emit(signal, signal);
}

describe("installShutdownSignals", () => {
  const installedHandles: { uninstall: () => void }[] = [];

  afterEach(() => {
    for (const handle of installedHandles.splice(0)) {
      handle.uninstall();
    }
  });

  it("invokes onGracefulShutdown on the first SIGINT", () => {
    const onGracefulShutdown = vi.fn();
    const onForceExit = vi.fn();
    const handle = installShutdownSignals({ onGracefulShutdown, onForceExit });
    installedHandles.push(handle);
    emit("SIGINT");
    expect(onGracefulShutdown).toHaveBeenCalledTimes(1);
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it("invokes onGracefulShutdown on the first SIGTERM", () => {
    const onGracefulShutdown = vi.fn();
    const onForceExit = vi.fn();
    const handle = installShutdownSignals({ onGracefulShutdown, onForceExit });
    installedHandles.push(handle);
    emit("SIGTERM");
    expect(onGracefulShutdown).toHaveBeenCalledTimes(1);
    expect(onForceExit).not.toHaveBeenCalled();
  });

  it("invokes onForceExit on a second signal after graceful shutdown was requested", () => {
    const onGracefulShutdown = vi.fn();
    const onForceExit = vi.fn();
    const handle = installShutdownSignals({ onGracefulShutdown, onForceExit });
    installedHandles.push(handle);
    emit("SIGINT");
    emit("SIGTERM");
    expect(onGracefulShutdown).toHaveBeenCalledTimes(1);
    expect(onForceExit).toHaveBeenCalledTimes(1);
  });

  it("removes both signal listeners on uninstall", () => {
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const handle = installShutdownSignals({ onGracefulShutdown: vi.fn(), onForceExit: vi.fn() });
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    handle.uninstall();
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });

  it("uninstall is idempotent", () => {
    const before = process.listenerCount("SIGINT");
    const handle = installShutdownSignals({ onGracefulShutdown: vi.fn(), onForceExit: vi.fn() });
    handle.uninstall();
    handle.uninstall();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("does not accumulate listeners across repeated install/uninstall cycles", () => {
    const before = process.listenerCount("SIGINT");
    for (let i = 0; i < 5; i += 1) {
      const handle = installShutdownSignals({ onGracefulShutdown: vi.fn(), onForceExit: vi.fn() });
      handle.uninstall();
    }
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  /**
   * Windows cannot deliver a real SIGINT/SIGTERM from a parent Node
   * process to a child Node process (`ChildProcess.kill()` forcefully
   * terminates regardless of signal name — empirically confirmed during
   * this phase's own development). A stdin command line is the
   * cross-platform graceful-shutdown trigger process-spawning test
   * harnesses use instead — see `apps/e2e`'s durable-restart spec. These
   * tests use the Vitest worker's own (non-TTY, piped) stdin directly.
   */
  describe("stdin shutdown trigger", () => {
    it("invokes onGracefulShutdown when the exact shutdown command line arrives on stdin", () => {
      const onGracefulShutdown = vi.fn();
      const onForceExit = vi.fn();
      const handle = installShutdownSignals({ onGracefulShutdown, onForceExit });
      installedHandles.push(handle);

      process.stdin.emit("data", Buffer.from(`${STDIN_SHUTDOWN_COMMAND}\n`));

      expect(onGracefulShutdown).toHaveBeenCalledTimes(1);
      expect(onForceExit).not.toHaveBeenCalled();
    });

    it("ignores stdin lines that do not exactly match the shutdown command", () => {
      const onGracefulShutdown = vi.fn();
      const handle = installShutdownSignals({ onGracefulShutdown, onForceExit: vi.fn() });
      installedHandles.push(handle);

      process.stdin.emit("data", Buffer.from("hello\n"));
      process.stdin.emit("data", Buffer.from(`not${STDIN_SHUTDOWN_COMMAND}\n`));

      expect(onGracefulShutdown).not.toHaveBeenCalled();
    });

    it("shares the same first-graceful/second-forced state between a signal and a stdin command", () => {
      const onGracefulShutdown = vi.fn();
      const onForceExit = vi.fn();
      const handle = installShutdownSignals({ onGracefulShutdown, onForceExit });
      installedHandles.push(handle);

      emit("SIGINT");
      process.stdin.emit("data", Buffer.from(`${STDIN_SHUTDOWN_COMMAND}\n`));

      expect(onGracefulShutdown).toHaveBeenCalledTimes(1);
      expect(onForceExit).toHaveBeenCalledTimes(1);
    });

    it("handles a shutdown command split across multiple stdin data chunks", () => {
      const onGracefulShutdown = vi.fn();
      const handle = installShutdownSignals({ onGracefulShutdown, onForceExit: vi.fn() });
      installedHandles.push(handle);

      process.stdin.emit("data", Buffer.from(STDIN_SHUTDOWN_COMMAND.slice(0, 3)));
      process.stdin.emit("data", Buffer.from(`${STDIN_SHUTDOWN_COMMAND.slice(3)}\n`));

      expect(onGracefulShutdown).toHaveBeenCalledTimes(1);
    });

    it("does not accumulate stdin 'data' listeners across repeated install/uninstall cycles", () => {
      const before = process.stdin.listenerCount("data");
      for (let i = 0; i < 5; i += 1) {
        const handle = installShutdownSignals({
          onGracefulShutdown: vi.fn(),
          onForceExit: vi.fn(),
        });
        handle.uninstall();
      }
      expect(process.stdin.listenerCount("data")).toBe(before);
    });

    it("installs no stdin listener at all when stdin is an interactive TTY", () => {
      const originalIsTTY = process.stdin.isTTY;
      process.stdin.isTTY = true;
      try {
        const before = process.stdin.listenerCount("data");
        const handle = installShutdownSignals({
          onGracefulShutdown: vi.fn(),
          onForceExit: vi.fn(),
        });
        installedHandles.push(handle);
        expect(process.stdin.listenerCount("data")).toBe(before);
      } finally {
        process.stdin.isTTY = originalIsTTY;
      }
    });
  });
});
