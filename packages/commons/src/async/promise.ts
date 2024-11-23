/** A value that may be wrapped with a PromiseLike. */
export type MaybePromise<T> = T | PromiseLike<T>;

export const MaybePromise = {
  /** Transforms a value or promise with a maybe-async value mapper (and optionally error mapper). */
  map<T, R = T, R2 = never>(
    value: MaybePromise<T>,
    mapValue: (value: T) => MaybePromise<R>,
    mapError?: (err: unknown) => MaybePromise<R2>,
  ): MaybePromise<R | R2> {
    if (!MaybePromise.isThenable(value)) {
      return mapValue(value);
    }
    return value.then(mapValue, mapError);
  },

  /** Returns a single {@link MaybePromise} that fulfills with an array of fulfillment values from input {@link MaybePromise}s. */
  all<T>(values: Iterable<MaybePromise<T>>): MaybePromise<T[]> {
    let isAsync = false;
    const results: T[] = [];
    for (const value of values) {
      if (MaybePromise.isThenable(value)) {
        isAsync = true;
        break;
      }
      results.push(value);
    }
    return isAsync ? Promise.all(values) : results;
  },

  /** Returns if a value is a thenable. */
  isThenable<T>(value: MaybePromise<T>): value is PromiseLike<T> {
    return typeof (value as PromiseLike<T>)?.then === 'function';
  },

  /**
   * Wraps a {@link MaybePromise}-yielding generator function into a function that returns {@link MaybePromise}.
   * Control is returned back to the generator when the `yield`ed {@link MaybePromise} settles, similar to how `async`/`await` works.
   *
   * @example
   * ```ts
   * const add = MaybePromise.coroutine(function* (a: number, b: number) {
   *   const result1: number = yield Promise.resolve(a); // result1 === a
   *   const result2 = yield b; // result2 === b
   *   return result + result2;
   * });
   * const result = await add(1, 2); // result === 3
   * ```
   */
  coroutine<R = unknown, Args extends unknown[] = unknown[]>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    coroutineFn: (...args: Args) => Generator<unknown, MaybePromise<R>, any>,
    thisArg?: unknown,
  ): (...args: Args) => MaybePromise<R> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coroutine = new Coroutine<R, any>();
    return (...args) => coroutine.start(coroutineFn.call(thisArg, ...args));
  }
};

function* emptyCoroutine() { }

class Coroutine<R, V> {
  private coroutine = emptyCoroutine() as Generator<MaybePromise<V>, MaybePromise<R>, V>;

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
      if (MaybePromise.isThenable(value)) { return value.then(this.run, this.resume); }
      resolved = value;
    }
    return result.value;
  }

  private resume(e: unknown): MaybePromise<R> {
    const { done, value } = this.coroutine.throw(e);
    if (done) { return value; }
    return MaybePromise.isThenable(value) ? value.then(this.run, this.resume) : this.run(value);
  }
}
