import type { ConnectionState } from "../hooks/use-task-events";

const LABELS: Record<ConnectionState, string> = {
  idle: "No task selected",
  connecting: "Connecting to live updates…",
  connected: "Live",
  reconnecting: "Reconnecting…",
  completed: "Finished",
  disconnected: "Disconnected",
  error: "Stream error",
};

const DOT_CLASSES: Record<ConnectionState, string> = {
  idle: "bg-stone-300 dark:bg-stone-600",
  connecting: "bg-amber-400",
  connected: "bg-emerald-500",
  reconnecting: "bg-amber-400",
  completed: "bg-emerald-500",
  disconnected: "bg-stone-400",
  error: "bg-red-500",
};

export function ConnectionStatus({
  state,
  reconnectAttempt,
}: {
  readonly state: ConnectionState;
  readonly reconnectAttempt?: number;
}) {
  const label =
    state === "reconnecting" && reconnectAttempt
      ? `${LABELS[state]} (attempt ${String(reconnectAttempt)})`
      : LABELS[state];

  return (
    <p
      className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-300"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2.5 w-2.5 rounded-full ${DOT_CLASSES[state]}`}
      />
      <span>{label}</span>
    </p>
  );
}
