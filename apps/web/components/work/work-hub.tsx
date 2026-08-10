"use client";

import Link from "next/link";
import { KanbanBoard } from "../kanban/kanban-board";

const WORK_LINKS = [
  { href: "/tasks", label: "Task Console" },
  { href: "/ceo", label: "CEO Plans" },
  { href: "/boards", label: "Discussions" },
  { href: "/comparisons", label: "Comparisons" },
] as const;

/**
 * Feature 8 — the simplified nav's "Work" destination: the Kanban board
 * (unchanged, Feature 7's Simple/Detailed toggle included) plus one-click
 * access to the task/plan/discussion/comparison tools that used to need
 * their own top-level nav entries. Every one of those routes still exists
 * and is still directly reachable — this page only adds a shorter path to
 * them, it removes nothing.
 */
export function WorkHub({ baseUrl }: { readonly baseUrl: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-stone-900 dark:text-stone-100">Work</h1>
        <nav aria-label="Work sections" className="flex flex-wrap gap-2">
          {WORK_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
      <KanbanBoard baseUrl={baseUrl} />
    </div>
  );
}
