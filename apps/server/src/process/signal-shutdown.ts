export interface SignalShutdownHandlers {
  /** First SIGINT/SIGTERM: request a graceful shutdown. */
  readonly onGracefulShutdown: () => void;
  /** A second signal while a graceful shutdown is already in flight: force an immediate exit. */
  readonly onForceExit: () => void;
}

export interface SignalShutdownHandle {
  /** Removes all installed signal listeners. Idempotent — safe to call more than once. */
  readonly uninstall: () => void;
}

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** The exact line this process treats as a graceful-shutdown request over stdin — see `installStdinShutdownTrigger` below. */
export const STDIN_SHUTDOWN_COMMAND = "SHUTDOWN";

/**
 * Deliberately a separate, small implementation from Hall Runner's
 * `installSignalCancellation` (`@hall-of-wisdom/hall-runner`), rather than
 * a reused import: that function is scoped to cancelling *one run*
 * (SIGINT only) for a CLI process, while this one gracefully shuts down
 * *the whole server* (all active runs) and additionally listens for
 * SIGTERM, which a server needs (process managers send SIGTERM, not
 * SIGINT). The underlying idempotent first-signal-graceful,
 * second-signal-forced policy is intentionally the same shape.
 *
 * Also installs `installStdinShutdownTrigger` (below), sharing the same
 * `shutdownRequested` flag, so a real OS signal and a stdin command can
 * never race each other into inconsistent graceful/forced behavior.
 */
export function installShutdownSignals(handlers: SignalShutdownHandlers): SignalShutdownHandle {
  let shutdownRequested = false;

  const trigger = (): void => {
    if (shutdownRequested) {
      handlers.onForceExit();
      return;
    }
    shutdownRequested = true;
    handlers.onGracefulShutdown();
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, trigger);
  }
  const stdinHandle = installStdinShutdownTrigger(trigger);

  let uninstalled = false;
  const uninstall = (): void => {
    if (uninstalled) return;
    uninstalled = true;
    for (const signal of SHUTDOWN_SIGNALS) {
      process.removeListener(signal, trigger);
    }
    stdinHandle.uninstall();
  };

  return { uninstall };
}

/**
 * Windows cannot deliver a real SIGINT/SIGTERM from a parent Node process
 * to a child Node process — `ChildProcess.kill()` is documented (and was
 * empirically re-confirmed during Phase 13.1's own development, including
 * checking `SIGBREAK` and a plain `taskkill` without `/F`) to terminate
 * the child forcefully regardless of the signal name given, on every
 * variant tried. A stdin line is the standard, idiomatic way a long-running
 * Windows console daemon accepts a graceful-stop request from whatever
 * spawned it — this is not reachable from the network or the browser, and
 * grants no new capability beyond what the process's own parent (which
 * already fully controls its stdin, argv, and environment) could already
 * do by simply holding a signal-equivalent side channel open. It is
 * inert whenever stdin is an interactive TTY (a real terminal's own
 * Ctrl+C already works natively on every platform, unaffected by this),
 * activating only for a non-interactive (piped) stdin — exactly the
 * process-spawning case that needs it, e.g. `apps/e2e`'s durable-restart
 * Playwright spec.
 */
function installStdinShutdownTrigger(trigger: () => void): SignalShutdownHandle {
  if (process.stdin.isTTY) {
    return { uninstall: () => undefined };
  }

  let buffer = "";
  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line === STDIN_SHUTDOWN_COMMAND) trigger();
    }
  };

  process.stdin.on("data", onData);
  process.stdin.resume();

  let uninstalled = false;
  return {
    uninstall: () => {
      if (uninstalled) return;
      uninstalled = true;
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
    },
  };
}
