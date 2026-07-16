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

/**
 * Deliberately a separate, small implementation from Hall Runner's
 * `installSignalCancellation` (`@hall-of-wisdom/hall-runner`), rather than
 * a reused import: that function is scoped to cancelling *one run*
 * (SIGINT only) for a CLI process, while this one gracefully shuts down
 * *the whole server* (all active runs) and additionally listens for
 * SIGTERM, which a server needs (process managers send SIGTERM, not
 * SIGINT). The underlying idempotent first-signal-graceful,
 * second-signal-forced policy is intentionally the same shape.
 */
export function installShutdownSignals(handlers: SignalShutdownHandlers): SignalShutdownHandle {
  let shutdownRequested = false;

  const onSignal = (): void => {
    if (shutdownRequested) {
      handlers.onForceExit();
      return;
    }
    shutdownRequested = true;
    handlers.onGracefulShutdown();
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, onSignal);
  }

  let uninstalled = false;
  const uninstall = (): void => {
    if (uninstalled) return;
    uninstalled = true;
    for (const signal of SHUTDOWN_SIGNALS) {
      process.removeListener(signal, onSignal);
    }
  };

  return { uninstall };
}
