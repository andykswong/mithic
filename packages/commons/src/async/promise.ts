import { reduce } from './maybe-async.ts';

/** A value that may be wrapped with a PromiseLike. */
export type MaybePromise<T> = T | PromiseLike<T>;

/** Type-safe function that returns a {@link MaybePromise}. */
export type MaybePromiseFn<Args extends unknown[] = unknown[], R = void> = (...args: Args) => MaybePromise<R>;

export const MaybePromise = {
  /** Transforms a value or promise with a maybe-async value mapper (and optionally error mapper). */
  map: mapAsync,

  /** Returns if a value is a thenable */
  isThenable
};

/** Returns if a value is like a thenable. */
export function isThenable<T>(value: MaybePromise<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T>)?.then === 'function';
}

/** Transforms a value or promise with a maybe-async value mapper (and optionally error mapper). */
export function mapAsync<T, R = T, R2 = never>(
  value: MaybePromise<T>,
  mapValue: (value: T) => MaybePromise<R>,
  mapError?: (err: unknown) => MaybePromise<R2>,
): MaybePromise<R | R2> {
  if (!isThenable(value)) {
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

function* emptyCoroutine() { }

class MaybeAsyncCorountine<R, V> {
  private coroutine: Generator<MaybePromise<V>, MaybePromise<R>, V> =
    emptyCoroutine() as Generator<MaybePromise<V>, MaybePromise<R>, V>;

  public constructor() {
    this.run = this.run.bind(this);
    this.resume = this.resume.bind(this);
  }

  public start(coroutine: Generator<MaybePromise<V>, MaybePromise<R>, V>): MaybePromise<R> {
    this.coroutine = coroutine;
    return this.run();
  }

  private run(resolved?: V): MaybePromise<R> {
    let result;
    while (!(result = resolved === void 0 ? this.coroutine.next() : this.coroutine.next(resolved)).done) {
      const value = result.value;
      if (isThenable(value)) { return value.then(this.run, this.resume); }
      resolved = value;
    }
    return result.value;
  }

  private resume(e: unknown): MaybePromise<R> {
    const { done, value } = this.coroutine.throw(e);
    if (done) { return value; }
    return isThenable(value) ? value.then(this.run, this.resume) : this.run(value);
  }
}

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
export function maybeAsync<R = unknown, Args extends unknown[] = unknown[]>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coroutineFn: (...args: Args) => Generator<unknown, MaybePromise<R>, any>,
  thisArg?: unknown,
): (...args: Args) => MaybePromise<R> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coroutine = new MaybeAsyncCorountine<R, any>();
  return (...args) => coroutine.start(coroutineFn.call(thisArg, ...args));
}

/** Reduces a {@link MaybePromise} of array using a maybe-async reducer function. */
export const reduceAsync = maybeAsync(reduce) as ReduceAsync;
