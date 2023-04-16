import { AbortOptions, CodedError, ContentId, MaybeAsyncIterableIterator, MaybePromise } from '@mithic/commons';

/** A content-addressable data store. */
export interface ContentAddressedStore<K = ContentId, V = Uint8Array> extends ReadonlyContentAddressedStore<K, V> {
  /** Deletes the value with given key. */
  delete(key: K, options?: AbortOptions): MaybePromise<void>;

  /** Deletes the values with given keys. */
  deleteMany(keys: Iterable<K>, options?: AbortOptions): MaybeAsyncIterableIterator<CodedError<K> | undefined>;

  /** Puts given value and returns its key. */
  put(value: V, options?: AbortOptions): MaybePromise<K>;

  /** Puts given list of values and returns their keys. */
  putMany(values: Iterable<V>, options?: AbortOptions): MaybeAsyncIterableIterator<K>;
}

/** A readonly content-addressable data store. */
export interface ReadonlyContentAddressedStore<K = ContentId, V = Uint8Array> {
  /** Gets the data identified by given key. */
  get(key: K, options?: AbortOptions): MaybePromise<V | undefined>;

  /** Gets the list of data identified by given keys. */
  getMany(keys: Iterable<K>, options?: AbortOptions): MaybeAsyncIterableIterator<V | undefined>;
}
