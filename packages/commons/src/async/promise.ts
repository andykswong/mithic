import { reduce } from './maybe-async.js';

/** A value that may be wrapped with a PromiseLike. */
export type MaybePromise<T> = T | PromiseLike<T>;

export const MaybePromise = {
  /** Transforms a value or promise with a maybe-async value mapper (and optionally error mapper). */
  map: mapAsync,

  /** Returns if a value is like a promise (thenable). */
  isPromiseLike
};

/** Returns if a value is like a promise (thenable). */
export function isPromiseLike<T>(value: MaybePromise<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T>)?.then === 'function';
}

/** Transforms a value or promise with a maybe-async value mapper (and optionally error mapper). */
export function mapAsync<T, R = T, R2 = never>(
  value: MaybePromise<T>,
  mapValue: (value: T) => MaybePromise<R>,
  mapError?: (err: unknown) => MaybePromise<R2>,
): MaybePromise<R | R2> {
  if (!isPromiseLike(value)) {
    return mapValue(value);
  }
  return value.then(mapValue, mapError);
}

/** Type of {@link reduceAsync} function. */
export type ReduceAsync = {
  <T>(
    array: MaybePromise<T[]>,
    reducer: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => MaybePromise<T>
  ): MaybePromise<T>;

  <T, U = T>(
    array: MaybePromise<T[]>,
    reducer: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => MaybePromise<U>,
    initialValue: MaybePromise<U>
  ): MaybePromise<U>;
};

/** Reduces a {@link MaybePromise} of array using a maybe-async reducer function. */
export const reduceAsync = maybeAsync(reduce) as ReduceAsync;

/**
 * Wraps a {@link MaybePromise}-yielding coroutine (generator function) into a function that returns {@link MaybePromise}.
 * This allows you to use `maybeAsync`/yield in a similar way to async/await,
 * where `yield maybePromise` will return awaited / resolved value.
 *
 * @example
 * ```ts
 * const add = maybeAsync(function* (a: number, b: number) {
 *   const result1: number = yield Promise.resolve(a); // result1 === a
 *   const result2 = yield b; // result2 === b
 *   return result + result2;
 * });
 * const result = await add(1, 2); // result === 3
 * ```
 */
export function maybeAsync<T = unknown, Args extends unknown[] = unknown[]>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coroutine: (...args: Args) => Generator<unknown, MaybePromise<T>, any>,
  thisArg?: unknown,
): (...args: Args) => MaybePromise<T> {
  return (...args) => {
    const iter = coroutine.call(thisArg, ...args);

    return (function run(resolved?: unknown): MaybePromise<T> {
      const result = resolved === void 0 ? iter.next() : iter.next(resolved);
      if (result.done) {
        return result.value;
      }
      return mapAsync(result.value, run);
    })();
  };
}
