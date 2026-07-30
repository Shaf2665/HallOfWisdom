/**
 * Phase 14.1 — structural (not nominal) contract every store `createEphemeralAtomicUnit`
 * coordinates must satisfy. Deliberately NOT `instanceof`-checked against a
 * concrete class: Task 6's `wrapTaskStoreWithMutationHook` returns a plain
 * object (not a `TaskStore` instance) that must still participate here by
 * pass-through delegating `snapshot()`/`restore()` to the real store it
 * wraps — structural typing is what lets that wrapper satisfy this
 * contract without `createEphemeralAtomicUnit` (or its caller) needing to
 * know a wrapper is involved at all.
 */
export interface Snapshottable<S> {
  snapshot(): S;
  restore(snapshot: S): void;
}

export interface EphemeralAtomicUnitStores<TTask, TBoard, TMessage, TPlan> {
  readonly taskStore: Snapshottable<TTask>;
  readonly boardStore: Snapshottable<TBoard>;
  readonly messageStore: Snapshottable<TMessage>;
  readonly planStore: Snapshottable<TPlan>;
}

/**
 * Phase 14.1 — gives ephemeral (in-memory) mode the same all-or-nothing
 * guarantee `withTransaction` already gives durable mode, without adding
 * any generic transaction API reachable from a route or the browser. Not
 * a real transaction log — a bounded, four-store snapshot/restore: every
 * store's entire in-memory state is cloned before `fn()` runs, and
 * restored wholesale if `fn()` throws. Each store's own `snapshot()`
 * doc comment explains why a deep or shallow clone is correct for that
 * store specifically.
 *
 * Naturally reentrant with no special-casing: a nested call takes its
 * own snapshot at its own entry point, so if the OUTER call later
 * throws, its restore (taken before the inner call ever ran) rolls back
 * everything the inner call committed too — the inner call's own
 * "commit" was never anything more than "didn't throw," not a durable
 * checkpoint.
 */
export function createEphemeralAtomicUnit<TTask, TBoard, TMessage, TPlan>(
  stores: EphemeralAtomicUnitStores<TTask, TBoard, TMessage, TPlan>,
): <T>(fn: () => T) => T {
  return function runAtomicUnit<T>(fn: () => T): T {
    const taskSnapshot = stores.taskStore.snapshot();
    const boardSnapshot = stores.boardStore.snapshot();
    const messageSnapshot = stores.messageStore.snapshot();
    const planSnapshot = stores.planStore.snapshot();
    try {
      return fn();
    } catch (error) {
      stores.taskStore.restore(taskSnapshot);
      stores.boardStore.restore(boardSnapshot);
      stores.messageStore.restore(messageSnapshot);
      stores.planStore.restore(planSnapshot);
      throw error;
    }
  };
}
