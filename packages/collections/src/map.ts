import { AbortOptions, MaybePromise } from '@mithic/commons';

/** A readonly Map that may have async operations. */
export interface MaybeAsyncReadonlyMap<K, V> {
  /** Gets a value by key from the map. */
  get(key: K, options?: AbortOptions): MaybePromise<V | undefined>;

  /** Returns whether a key exists in the map. */
  has(key: K, options?: AbortOptions): MaybePromise<boolean>;
}

/** A Map that may have async operations. */
export interface MaybeAsyncMap<K, V> extends MaybeAsyncReadonlyMap<K, V> {
  /** Sets an entry in the map. */
  set(key: K, value: V, options?: AbortOptions): MaybePromise<unknown>;

  /** Deletes an entry by key from the map. */
  delete(key: K, options?: AbortOptions): MaybePromise<unknown>;
}
