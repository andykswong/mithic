/** A type that maybe wrapped with a PromiseLike. */
export type MaybePromise<T> = T | PromiseLike<T>;

/** Returns if a value is like a promise (thenable). */
export function isPromiseLike<T>(value: MaybePromise<T>): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T>)?.then === 'function';
}

/** Transforms a value or promise with value mapper (and optionally error mapper) functions that may be async. */
export function mapAsync<T, R = T, R2 = never>(
  value: MaybePromise<T>,
  mapValue: (value: T) => MaybePromise<R>,
  mapError?: (err: unknown) => MaybePromise<R2>,
): MaybePromise<R | R2> {
  if (!isPromiseLike(value)) {
    return mapValue(value);
  }

  return Promise.resolve(value)
    .then(mapValue, mapError);
}
