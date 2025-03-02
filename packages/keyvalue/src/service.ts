import type { MaybePromise } from '@mithic/commons';
import type { KeyResponse, KeySelector } from './types.ts';

/** Key-value store provider. */
export interface KeyValueProvider {
  /**
   * Opens a key-value store bucket for given identifier.
   * @throws {@link StoreError}
   */
  open(identifier: string): MaybePromise<KeyValueStore>;
}

/** Key-value store bucket. */
export interface KeyValueStore extends Partial<Disposable> {
  /**
   * Returns whether a key exists in the store.
   * @throws {@link StoreError}
   */
  exists(key: string): MaybePromise<boolean>;

  /**
   * Gets range of keys in the store.
   * @throws {@link StoreError}
   */
  listKeys(selector?: KeySelector, cursor?: string): MaybePromise<KeyResponse>;

  /**
   * Gets the key-value pairs associated with the keys in the store.
   * @throws {@link StoreError}
   */
  getMany(keys: string[]): MaybePromise<(Uint8Array | null)[]>;

  /**
   * Upserts or deletes the values associated with the keys in the store.
   * @throws {@link StoreError}
   */
  updateMany(keyValues: [key: string, value: Uint8Array | null][]): MaybePromise<void>;

  /**
   * Atomically increments the value associated with the key in the store by the given delta. It returns the new value.
   * If the key does not exist in the store, it creates a new key-value pair with the value set to the given delta.
   * @throws {@link StoreError}
   */
  increment(key: string, delta: bigint): MaybePromise<bigint>;

  /**
   * Atomically sets the value associated with the key in the store to the given value.
   * It returns `true` if the value was set properly, or `false` if the swap failed.
   * @throws {@link StoreError}
   */
  compareAndSwap(key: string, oldValue?: Uint8Array, newValue?: Uint8Array): MaybePromise<boolean>;
}

/** Synchronous key-value store provider. */
export interface SyncKeyValueProvider extends KeyValueProvider {
  open(identifier: string): SyncKeyValueStore;
}

/** Synchronous key-value store bucket. */
export interface SyncKeyValueStore extends KeyValueStore {
  exists(key: string): boolean;
  listKeys(selector?: KeySelector, cursor?: string): KeyResponse;
  getMany(keys: string[]): (Uint8Array | null)[];
  updateMany(keyValues: [key: string, value: Uint8Array | null][]): void;
  increment(key: string, delta: bigint): bigint;
  compareAndSwap(key: string, oldValue?: Uint8Array, newValue?: Uint8Array): boolean;
}
