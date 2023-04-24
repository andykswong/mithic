import { AbortOptions, MaybePromise } from '@mithic/commons';

/** A readonly Set that may have async operations. */
export interface MaybeAsyncReadonlySet<T> {
  /** Returns whether a value exists in the set. */
  has(value: T, options?: AbortOptions): MaybePromise<boolean>;
}

/** A Set that may have async operations. */
export interface MaybeAsyncSet<T> extends MaybeAsyncAppendOnlySet<T> {
  /** Deletes an entry from the set. */
  delete(value: T, options?: AbortOptions): MaybePromise<unknown>;
}

/** An append-only Set that may have async operations. */
export interface MaybeAsyncAppendOnlySet<T> extends MaybeAsyncReadonlySet<T> {
  /** Adds an entry to the set. Returns `MaybePromise<unknown>` to be compatible with ES Set. */
  add(value: T, options?: AbortOptions): MaybePromise<unknown>;
}
