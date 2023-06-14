import { AbortOptions, ContentId, MaybeAsyncIterableIterator, MaybePromise } from '@mithic/commons';
import { MaybeAsyncReadonlySet, MaybeAsyncReadonlySetBatch, MaybeAsyncSetDeleteBatch } from './set.js';

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

/** A readyonly map store with auto-generated key. */
export interface ReadonlyAutoKeyMap<K = ContentId, V = Uint8Array> extends MaybeAsyncReadonlyMap<K, V> {
  /** Gets the key of given value. */
  getKey(value: V, options?: AbortOptions): MaybePromise<K>;
}

/** A map store with auto-generated key. */
export interface AutoKeyMap<K = ContentId, V = Uint8Array> extends AppendOnlyAutoKeyMap<K, V> {
  /** Deletes the value with given key. */
  delete(key: K, options?: AbortOptions): MaybePromise<void>;
}

/** An append-only map store with auto-generated key. */
export interface AppendOnlyAutoKeyMap<K = ContentId, V = Uint8Array> extends ReadonlyAutoKeyMap<K, V> {
  /** Puts given value and returns its key. */
  put(value: V, options?: AbortOptions): MaybePromise<K>;
}

/** Batch APIs for a {@link MaybeAsyncReadonlyMap}. */
export interface MaybeAsyncReadonlyMapBatch<K, V> extends MaybeAsyncReadonlySetBatch<K> {
  /** Gets the list of data identified by given keys. */
  getMany(keys: Iterable<K>, options?: AbortOptions): MaybeAsyncIterableIterator<V | undefined>;
}

/** Batch set API for a {@link MaybeAsyncMap}. */
export interface MaybeAsyncMapSetBatch<K, V> {
  /** Sets given list of entries. */
  setMany(entries: Iterable<[K, V]>, options?: AbortOptions): MaybeAsyncIterableIterator<Error | undefined>;
}

/** Batch update API for a {@link MaybeAsyncMap}. */
export interface MaybeAsyncMapUpdateBatch<K, V> {
  /** Sets or deletes given list of entries. */
  updateMany(
    entries: Iterable<[key: K, value?: V]>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<Error | undefined>;
}

/** Batch APIs for a {@link MaybeAsyncMap}. */
export interface MaybeAsyncMapBatch<K, V> extends MaybeAsyncReadonlyMapBatch<K, V>, MaybeAsyncMapSetBatch<K, V>,
  MaybeAsyncSetDeleteBatch<K>, MaybeAsyncMapUpdateBatch<K, V> {
}

/** Batch put API for a {@link AutoKeyMap}. */
export interface AutoKeyMapPutBatch<K = ContentId, V = Uint8Array> {
  /** Puts given list of values and returns their keys. */
  putMany(values: Iterable<V>, options?: AbortOptions): MaybeAsyncIterableIterator<[key: K, error?: Error]>;
}

/** Batch APIs for a {@link AutoKeyMap}. */
export interface AutoKeyMapBatch<K = ContentId, V = Uint8Array>
  extends MaybeAsyncReadonlyMapBatch<K, V>, MaybeAsyncSetDeleteBatch<K>, AutoKeyMapPutBatch<K, V> {
}
