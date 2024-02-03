/**
 * Instructions for `maybeAsync` coroutine.
 * @packageDocumentation
 */

import type { MaybePromise } from './promise.ts';

/**
 * `yield*` instruction for `maybeAsync` to resolve a {@link MaybePromise} in a type-safe way.
 *
 * @example
 * ```ts
 * maybeAsync(function* () {
 *   return yield* resolve(Promise.resolve(123)); // 123
 * });
 * ```
 */
export function* resolve<T>(promise: MaybePromise<T>): Generator<MaybePromise<T>, Awaited<T>, Awaited<T>> {
  return (yield promise) as Awaited<T>;
}

/**
 * `yield*` instruction for `maybeAsync` to reduce a {@link MaybePromise} of array using a maybe-async reducer.
 */
export function reduce<T>(
  array: MaybePromise<T[]>,
  reducer: (previousValue: T, currentValue: T, currentIndex: number, array: T[]) => MaybePromise<T>
): Generator<MaybePromise<T>, Awaited<T>, Awaited<T>>;
export function reduce<T, U = T>(
  array: MaybePromise<T[]>,
  reducer: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => MaybePromise<U>,
  initialValue: MaybePromise<U>
): Generator<MaybePromise<U>, Awaited<U>, Awaited<U>>;
export function* reduce<T, U = T>(
  array: MaybePromise<T[]>,
  reducer: (previousValue: U, currentValue: T, currentIndex: number, array: T[]) => MaybePromise<U>,
  initialValue?: MaybePromise<U>
) {
  const resolvedArray: T[] = yield array;
  const resolvedInitial: U | undefined = initialValue !== void 0 && (yield initialValue);
  let result = (resolvedInitial ?? resolvedArray[0]) as U;
  for (let index = resolvedInitial === void 0 ? 1 : 0; index < resolvedArray.length; ++index) {
    result = yield reducer(result, resolvedArray[index], index, resolvedArray);
  }
  return result;
}
