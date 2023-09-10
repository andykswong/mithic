import { AbortOptions, MaybeAsyncIterableIterator, MaybePromise } from '@mithic/commons';

/** A readonly Set that may have async operations. */
export interface MaybeAsyncReadonlySet<T> {
  /** Returns whether a value exists in the set. */
  has(value: T, options?: AbortOptions): MaybePromise<boolean>;
}

/** A Set that may have async operations. */
export interface MaybeAsyncSet<T> extends MaybeAsyncAppendOnlySet<T> {
  /** Deletes an entry from the set. Returns `MaybePromise<unknown>` to be compatible with ES Set. */
  delete(value: T, options?: AbortOptions): MaybePromise<unknown>;
}

/** An append-only Set that may have async operations. */
export interface MaybeAsyncAppendOnlySet<T> extends MaybeAsyncReadonlySet<T> {
  /** Adds an entry to the set. Returns `MaybePromise<unknown>` to be compatible with ES Set. */
  add(value: T, options?: AbortOptions): MaybePromise<unknown>;
}

/** Batch APIs for a {@link MaybeAsyncReadonlySet}. */
export interface MaybeAsyncReadonlySetBatch<T> {
  /** Checks if given keys exist in the set. */
  hasMany(keys: Iterable<T>, options?: AbortOptions): MaybeAsyncIterableIterator<boolean>;
}

/** Batch delete API for a {@link MaybeAsyncSet}. */
export interface MaybeAsyncSetDeleteBatch<T> {
  /** Deletes the values with given keys. */
  deleteMany(keys: Iterable<T>, options?: AbortOptions): MaybeAsyncIterableIterator<Error | undefined>;
}

/** Batch add API for a {@link MaybeAsyncSet}. */
export interface MaybeAsyncSetAddBatch<T> {
  /** Adds the values with given keys to the set. */
  addMany(keys: Iterable<T>, options?: AbortOptions): MaybeAsyncIterableIterator<Error | undefined>;
}

/** Batch update API for a {@link MaybeAsyncSet}. */
export interface MaybeAsyncSetUpdateBatch<T> {
  /** Sets or deletes given list of keys. */
  updateMany(keys: Iterable<[key: T, isDelete?: boolean]>, options?: AbortOptions): MaybeAsyncIterableIterator<Error | undefined>;
}

/** Batch APIs for a {@link MaybeAsyncSet}. */
export interface MaybeAsyncSetBatch<T> extends MaybeAsyncReadonlySetBatch<T>, MaybeAsyncSetAddBatch<T>,
  MaybeAsyncSetDeleteBatch<T>, MaybeAsyncSetUpdateBatch<T> {
}
