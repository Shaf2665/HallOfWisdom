"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { listTasks } from "../lib/api-client";
import { useAttentionItems } from "../hooks/use-attention-items";

const RECENT_COUNT = 5;
const ACTIVE_TASK_STATUSES = new Set(["assigned", "running"]);

interface RecentItem {
  readonly id: string;
  readonly label: string;
}

interface OverviewData {
  readonly activeWorkCount: number;
  readonly recentlyCompleted: readonly RecentItem[];
  readonly recentRequests: readonly RecentItem[];
}

function OverviewCard({
  title,
  href,
  children,
}: {
  readonly title: string;
  readonly href: string;
  readonly children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-xl border border-stone-200 bg-white p-3 text-left hover:border-amber-300 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-amber-800"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
        {title}
      </p>
      {children}
    </Link>
  );
}

function RecentList({ items }: { readonly items: readonly RecentItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-stone-400 dark:text-stone-500">None yet</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => (
        <li key={item.id} className="truncate text-sm text-stone-700 dark:text-stone-200">
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Feature 6 — a compact glance strip above the chat log. Every number here
 * is derived from the same durable task/plan APIs the rest of the app
 * already reads (`useAttentionItems` for the shared attention derivation,
 * `listTasks` for work/recency) — nothing new is persisted or invented.
 */
export function GatewayOverview({ baseUrl }: { readonly baseUrl: string }) {
  const attentionItems = useAttentionItems(baseUrl);
  const [overview, setOverview] = useState<OverviewData | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listTasks(baseUrl, { signal: controller.signal })
      .then(({ tasks }) => {
        if (controller.signal.aborted) return;
        const activeWorkCount = tasks.filter((record) =>
          ACTIVE_TASK_STATUSES.has(record.task.status),
        ).length;
        const recentlyCompleted = tasks
          .filter((record) => record.task.status === "completed")
          .sort((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt))
          .slice(0, RECENT_COUNT)
          .map((record) => ({ id: record.task.taskId, label: record.task.title }));
        const recentRequests = tasks
          .filter((record) => record.task.source === "wisdom_gateway")
          .sort((left, right) => right.task.createdAt.localeCompare(left.task.createdAt))
          .slice(0, RECENT_COUNT)
          .map((record) => ({
            id: record.task.taskId,
            label: `${record.task.projectId} · ${record.task.title}`,
          }));
        setOverview({ activeWorkCount, recentlyCompleted, recentRequests });
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [baseUrl]);

  if (!overview) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <OverviewCard title="Active work" href="/board">
        <p className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {overview.activeWorkCount}
        </p>
      </OverviewCard>
      <OverviewCard title="Needs your attention" href="/attention">
        <p
          className={`text-2xl font-semibold ${
            attentionItems.length > 0
              ? "text-amber-700 dark:text-amber-400"
              : "text-stone-900 dark:text-stone-100"
          }`}
        >
          {attentionItems.length}
        </p>
      </OverviewCard>
      <OverviewCard title="Recently completed" href="/board">
        <RecentList items={overview.recentlyCompleted} />
      </OverviewCard>
      <OverviewCard title="Recent requests" href="/tasks">
        <RecentList items={overview.recentRequests} />
      </OverviewCard>
    </div>
  );
}
