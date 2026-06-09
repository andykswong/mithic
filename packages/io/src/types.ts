/** A value that may or may not be wrapped in a Promise, parameterized by sync mode. */
export type MaybePromise<T, Sync extends boolean = boolean> =
  Sync extends true ? T : T | Promise<T>;

/** Check if a value is a thenable (has a .then method). */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value != null && typeof (value as PromiseLike<unknown>).then === 'function';
}

/** Chain a MaybePromise value with a function that returns MaybePromise. */
export function chainMaybePromise<T, U, Sync extends boolean>(
  value: MaybePromise<T, Sync>,
  fn: (v: T) => MaybePromise<U, Sync>,
): MaybePromise<U, Sync> {
  if (isThenable(value)) {
    return (value as unknown as Promise<T>).then(fn) as MaybePromise<U, Sync>;
  }
  return fn(value as T);
}

/** Map a MaybePromise value with a pure (sync) function. */
export function mapMaybePromise<T, U, Sync extends boolean>(
  value: MaybePromise<T, Sync>,
  fn: (v: T) => U,
): MaybePromise<U, Sync> {
  if (isThenable(value)) {
    return (value as unknown as Promise<T>).then(fn) as MaybePromise<U, Sync>;
  }
  return fn(value as T) as MaybePromise<U, Sync>;
}
