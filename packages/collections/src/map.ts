import { AbortOptions, CodedError, ContentId, MaybeAsyncIterableIterator, MaybePromise } from '@mithic/commons';
import { MaybeAsyncReadonlySet } from './set.js';

/** A readonly Map that may have async operations. */
export interface MaybeAsyncReadonlyMap<K, V> extends MaybeAsyncReadonlySet<K> {
  /** Gets a value by key from the map. */
  get(key: K, options?: AbortOptions): MaybePromise<V | undefined>;

  /** Returns whether a key exists in the map. */
  has(key: K, options?: AbortOptions): MaybePromise<boolean>;
}

/** A Map that may have async operations. */
export interface MaybeAsyncMap<K, V> extends MaybeAsyncReadonlyMap<K, V> {
  /** Deletes an entry by key from the map. Returns `MaybePromise<unknown>` to be compatible with ES Map. */
  delete(key: K, options?: AbortOptions): MaybePromise<unknown>;

  /** Sets an entry in the map. Returns `MaybePromise<unknown>` to be compatible with ES Map. */
  set(key: K, value: V, options?: AbortOptions): MaybePromise<unknown>;
}

/** A content-addressable data store. */
export interface ContentAddressedStore<K = ContentId, V = Uint8Array> extends AppendOnlyContentAddressedStore<K, V> {
  /** Deletes the value with given key. */
  delete(key: K, options?: AbortOptions): MaybePromise<void>;

  /** Puts given value and returns its key. */
  put(value: V, options?: AbortOptions): MaybePromise<K>;
}

/** An append-only content-addressable data store. */
export interface AppendOnlyContentAddressedStore<K = ContentId, V = Uint8Array> extends MaybeAsyncReadonlyMap<K, V> {
  /** Puts given value and returns its key. */
  put(value: V, options?: AbortOptions): MaybePromise<K>;
}

/** Batch APIs for a {@link ContentAddressedStore}. */
export interface ContentAddressedStoreBatch<K = ContentId, V = Uint8Array> {
  /** Deletes the values with given keys. */
  deleteMany(keys: Iterable<K>, options?: AbortOptions): MaybeAsyncIterableIterator<CodedError<K> | undefined>;

  /** Puts given list of values and returns their keys. */
  putMany(values: Iterable<V>, options?: AbortOptions): MaybeAsyncIterableIterator<K>;
  
  /** Gets the list of data identified by given keys. */
  getMany(keys: Iterable<K>, options?: AbortOptions): MaybeAsyncIterableIterator<V | undefined>;
}
