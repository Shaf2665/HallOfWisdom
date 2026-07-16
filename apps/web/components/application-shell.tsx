import type { ReactNode } from "react";
import { NavBar } from "./nav-bar";

export function ApplicationShell({
  statusSlot,
  children,
}: {
  readonly statusSlot: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-4 dark:border-stone-800">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-2xl font-semibold">Hall of Wisdom</h1>
          <NavBar />
        </div>
        {statusSlot}
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
