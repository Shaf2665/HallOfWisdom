"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Task Console" },
  { href: "/board", label: "Kanban Board" },
  { href: "/boards", label: "Communication Boards" },
  { href: "/agents", label: "Agents" },
] as const;

/**
 * Plain `next/link` navigation — no full page reload between `/` and
 * `/board`. The only reason this is a Client Component (unlike
 * `ApplicationShell`, which stays server-rendered): `usePathname()` is
 * needed to mark the current page for both sighted users (visual
 * emphasis) and assistive technology (`aria-current="page"`), and that
 * hook only works client-side.
 */
export function NavBar() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex gap-1">
      {LINKS.map((link) => {
        const isCurrent = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isCurrent ? "page" : undefined}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              isCurrent
                ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
