import { AbortOptions, MaybePromise } from '@mithic/commons';

/** A readonly Set that may have async operations. */
export interface MaybeAsyncReadonlySet<T> {
  /** Returns whether a value exists in the set. */
  has(value: T, options?: AbortOptions): MaybePromise<boolean>;
}

/** A Set that may have async operations. */
export interface MaybeAsyncSet<T> extends MaybeAsyncReadonlySet<T> {
  /** Adds an entry to the set. */
  add(value: T, options?: AbortOptions): MaybePromise<unknown>;

  /** Deletes an entry from the set. */
  delete(value: T, options?: AbortOptions): MaybePromise<unknown>;
}
