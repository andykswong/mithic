import { MaybePromise, SyncOrAsyncIterable } from '@mithic/commons';
import { MaybeAsyncReadonlyMap } from '../map.js';

/** The RHS values of a map join. */
export type MapJoinRHS<K, T extends MaybeAsyncReadonlyMap<K, unknown>[]> = { [K in keyof T]: ReturnType<T[K]['get']> };

/** Left joins a tuple iterable (e.g. a Map) with other Maps by key. */
export function* mapJoin<L extends readonly unknown[], K, I extends MaybeAsyncReadonlyMap<K, unknown>[]>(
  iterable: Iterable<L>,
  key: (lhs: L) => K | undefined,
  ...indices: I
): IterableIterator<[...L, ...MapJoinRHS<K, I>]> {
  for (const left of iterable) {
    const joinKey = key(left);
    const item = [...left];
    for (const index of indices) {
      item.push(joinKey !== void 0 ? index.get(joinKey) : void 0);
    }
    yield item as [...L, ...MapJoinRHS<K, I>];
  }
}

/** The RHS values of an async map join. */
export type AsyncMapJoinRHS<K, T extends MaybeAsyncReadonlyMap<K, unknown>[]> =
  { [K in keyof T]: Awaited<ReturnType<T[K]['get']>> };

/** Left joins a maybe-async tuple iterable (e.g. a Map) with other maybe-async maps by key. */
export async function* mapJoinAsync<L extends readonly unknown[], K, I extends MaybeAsyncReadonlyMap<K, unknown>[]>(
  iterable: SyncOrAsyncIterable<L>,
  key: (lhs: L) => MaybePromise<K | undefined>,
  ...indices: I
): AsyncIterableIterator<[...L, ...AsyncMapJoinRHS<K, I>]> {
  for await (const left of iterable) {
    const joinKey = await key(left);
    const item = [...left];
    for (const index of indices) {
      item.push(joinKey !== void 0 ? await index.get(joinKey) : void 0);
    }
    yield item as [...L, ...AsyncMapJoinRHS<K, I>];
  }
}
