import { MaybePromise } from './promise.ts';

/** An Iterator that may be async. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface MaybeAsyncIterator<T, TReturn = any, TNext = unknown> {
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

/** A generator that may be sync or async. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SyncOrAsyncGenerator<T = unknown, TReturn = any, TNext = unknown> =
  AsyncGenerator<T, TReturn, TNext> | Generator<T, TReturn, TNext>;
