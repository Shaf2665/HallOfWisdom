import type { NormalizedAgentEvent } from "@hall-of-wisdom/protocol";
import { isTerminalEvent } from "../lib/task-events";
import { EmptyState } from "./empty-state";

/** Defensive cap on the client side even though Hall Core already bounds stored events per task. */
const MAX_RENDERED_EVENTS = 1000;

function describeEvent(event: NormalizedAgentEvent): string {
  switch (event.type) {
    case "run.started":
      return "Agent started working";
    case "message.delta":
      return event.payload.text;
    case "tool.started":
      return `Started tool: ${event.payload.toolName}`;
    case "tool.completed":
      return `Completed tool: ${event.payload.toolName}`;
    case "file.changed":
      return `Modified ${event.payload.path}`;
    case "approval.required":
      return `Approval required — ${event.payload.riskLevel}`;
    case "run.completed":
      return "Task completed";
    case "run.failed":
      return `Task failed — ${event.payload.failure.code}`;
    case "run.cancelled":
      return "Task cancelled";
  }
}

function EventRow({ event }: { readonly event: NormalizedAgentEvent }) {
  const terminal = isTerminalEvent(event);
  return (
    <li
      className={`flex flex-col gap-1 rounded border px-3 py-2 text-sm ${
        terminal
          ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30"
          : "border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900"
      }`}
    >
      <div className="flex items-center justify-between gap-3 text-xs text-stone-500 dark:text-stone-400">
        <span>
          #{event.sequence} · {event.type}
        </span>
        <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time>
      </div>
      <p className="select-text break-words">{describeEvent(event)}</p>
      <details className="text-xs text-stone-400 dark:text-stone-500">
        <summary className="cursor-pointer select-none">Raw event</summary>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words">
          {JSON.stringify(event, null, 2)}
        </pre>
      </details>
    </li>
  );
}

export function TaskEventTimeline({
  events,
}: {
  readonly events: readonly NormalizedAgentEvent[];
}) {
  if (events.length === 0) {
    return <EmptyState message="No events yet." />;
  }

  const rendered = events.slice(0, MAX_RENDERED_EVENTS);

  return (
    <div>
      <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
        {rendered.map((event) => (
          <EventRow key={event.eventId} event={event} />
        ))}
      </ul>
      {events.length > MAX_RENDERED_EVENTS ? (
        <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
          Showing the first {MAX_RENDERED_EVENTS} of {events.length} events.
        </p>
      ) : null}
    </div>
  );
}
