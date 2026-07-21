/**
 * A minimal push/pull bridge: producers call `push()` from event-driven
 * callbacks (child process stdout/exit/error handlers), the consumer
 * pulls via the standard async iterator protocol (`for await`). This is
 * what lets `CodexRun` present an `AsyncIterable<NormalizedAgentEvent>`
 * over a real, push-based child process instead of a synchronous
 * generator loop.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #buffered: T[] = [];
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.#buffered.push(item);
    }
  }

  /** No more items will ever be pushed. Any pending `next()` resolves as done. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  #next(): Promise<IteratorResult<T>> {
    if (this.#buffered.length > 0) {
      const value = this.#buffered.shift() as T;
      return Promise.resolve({ value, done: false });
    }
    if (this.#closed) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.#next() };
  }
}
