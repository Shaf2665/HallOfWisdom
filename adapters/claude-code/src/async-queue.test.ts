import { describe, expect, it } from "vitest";
import { AsyncQueue } from "./async-queue.js";

async function drain<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of queue) {
    items.push(item);
  }
  return items;
}

describe("AsyncQueue", () => {
  it("yields items pushed before iteration begins", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    expect(await drain(queue)).toEqual([1, 2]);
  });

  it("yields items pushed after iteration has started waiting", async () => {
    const queue = new AsyncQueue<number>();
    const resultPromise = drain(queue);
    await Promise.resolve();
    queue.push(1);
    queue.push(2);
    queue.close();
    expect(await resultPromise).toEqual([1, 2]);
  });

  it("preserves push order", async () => {
    const queue = new AsyncQueue<string>();
    for (const item of ["a", "b", "c", "d"]) queue.push(item);
    queue.close();
    expect(await drain(queue)).toEqual(["a", "b", "c", "d"]);
  });

  it("stops iteration once closed with no more items", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.close();
    expect(await drain(queue)).toEqual([1]);
  });

  it("ignores a push after close", async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.push(1);
    expect(await drain(queue)).toEqual([]);
  });

  it("supports interleaved push/consume", async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    queue.push(1);
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    const pending = iterator.next();
    queue.push(2);
    expect(await pending).toEqual({ value: 2, done: false });
    queue.close();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it("can be iterated with a plain for-await loop multiple times conceptually (fresh queue each time)", async () => {
    const first = new AsyncQueue<number>();
    first.push(1);
    first.close();
    expect(await drain(first)).toEqual([1]);

    const second = new AsyncQueue<number>();
    second.push(2);
    second.close();
    expect(await drain(second)).toEqual([2]);
  });
});
