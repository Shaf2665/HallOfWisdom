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

/**
 * A named bag of `Snapshottable` stores — deliberately a plain keyed
 * record rather than four fixed positional type parameters, so a second
 * caller (Phase 15's `ceo-plan-execution-composition.ts`, coordinating
 * `planRunStore` + `signalStore`) can reuse this exact function instead
 * of a hand-rolled parallel coordinator. Each store's own snapshot value
 * type is intentionally erased to `unknown` here — this function only
 * ever calls `snapshot()`/`restore()` on the SAME store instance it read
 * from, so it never needs to know or check the shape in between; each
 * store's own `snapshot()`/`restore()` doc comment is still the source of
 * truth for why a deep or shallow clone is correct for that store.
 */
export type EphemeralAtomicUnitStores = Readonly<Record<string, Snapshottable<unknown>>>;

/**
 * Phase 14.1 (generalized in Phase 15.1) — gives ephemeral (in-memory)
 * mode the same all-or-nothing guarantee `withTransaction` already gives
 * durable mode, without adding any generic transaction API reachable from
 * a route or the browser. Not a real transaction log — a bounded
 * snapshot/restore over exactly the named stores passed in: every store's
 * entire in-memory state is cloned before `fn()` runs, and restored
 * wholesale, in the same order, if `fn()` throws.
 *
 * Naturally reentrant with no special-casing: a nested call takes its own
 * snapshot at its own entry point, so if the OUTER call later throws, its
 * restore (taken before the inner call ever ran) rolls back everything
 * the inner call committed too — the inner call's own "commit" was never
 * anything more than "didn't throw," not a durable checkpoint.
 */
export function createEphemeralAtomicUnit(
  stores: EphemeralAtomicUnitStores,
): <T>(fn: () => T) => T {
  const entries = Object.entries(stores);
  return function runAtomicUnit<T>(fn: () => T): T {
    const snapshots = entries.map(([key, store]) => [key, store.snapshot()] as const);
    try {
      return fn();
    } catch (error) {
      for (const [key, snapshot] of snapshots) {
        stores[key]?.restore(snapshot);
      }
      throw error;
    }
  };
}
