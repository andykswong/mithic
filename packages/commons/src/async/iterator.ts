import { MaybePromise } from './promise.js';

/** An Iterator that may be async. */
export interface MaybeAsyncIterator<T, TReturn = unknown, TNext = undefined> {
  next(...args: [] | [TNext]): MaybePromise<IteratorResult<T, TReturn>>;

  return?(value?: MaybePromise<TReturn>): MaybePromise<IteratorResult<T, TReturn>>;

  throw?(e?: unknown): MaybePromise<IteratorResult<T, TReturn>>;
}

/** An AsyncIterable that may support sync interface. */
export interface MaybeSyncIterable<T> extends AsyncIterable<T>, Partial<Iterable<T>> {}

/** An iterable that may be sync or async. */
export type SyncOrAsyncIterable<T> = AsyncIterable<T> | Iterable<T>;

/** An iterable Iterator that may be sync or async. */
export type MaybeAsyncIterableIterator<T> = MaybeAsyncIterator<T> & SyncOrAsyncIterable<T>;
