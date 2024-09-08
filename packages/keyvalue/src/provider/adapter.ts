import type { MaybePromise } from '@mithic/commons';
import type { KeyResponse, KeySelector } from '../types.ts';

/** Keyvalue store adapter. */
export interface KeyValueStore {
  /**
   * Tries to open a bucket for given identifier and returns an opaque bucket access token.
   * @throws {@link StoreError}
   */
  open(identifier: string): MaybePromise<string>;

  /** Closes a bucket connection. Implementation of this must never fail. */
  close(bucket: string): void;

  /**
   * Returns whether a key exists in the map.
   * @throws {@link StoreError}
   */
  exists(bucket: string, key: string): MaybePromise<boolean>;

  /**
   * Gets range of keys in the store.
   * @throws {@link StoreError}
   */
  listKeys(bucket: string, selector?: KeySelector, cursor?: string): MaybePromise<KeyResponse>;

  /**
   * Gets the key-value pairs associated with the keys in the store.
   * @throws {@link StoreError}
   */
  getMany(bucket: string, keys: string[]): MaybePromise<(Uint8Array | null)[]>;

  /**
   * Sets or deletes the values associated with the keys in the store.
   * @throws {@link StoreError}
   */
  updateMany(bucket: string, keyValues: [key: string, value: Uint8Array | null][]): MaybePromise<void>;

  /**
   * Atomically increments the value associated with the key in the store by the given delta. It returns the new value.
   * If the key does not exist in the store, it creates a new key-value pair with the value set to the given delta.
   * @throws {@link StoreError}
   */
  increment(bucket: string, key: string, delta: bigint): MaybePromise<bigint>;

  /** 
   * Atomically sets the value associated with the key in the store to the given value.
   * It returns `true` if the value was set properly, or `false` if the swap failed.
   * @throws {@link StoreError}
   */
  compareAndSwap(bucket: string, key: string, oldValue?: Uint8Array, newValue?: Uint8Array): MaybePromise<boolean>;
}

/** Synchronous keyvalue API provider. */
export interface KeyValueApiProvider extends KeyValueStore {
  open(identifier: string): string;
  close(bucket: string): void;
  exists(bucket: string, key: string): boolean;
  listKeys(bucket: string, selector?: KeySelector, cursor?: string): KeyResponse;
  getMany(bucket: string, keys: string[]): (Uint8Array | null)[];
  updateMany(bucket: string, keyValues: [key: string, value: Uint8Array | null][]): void;
  increment(bucket: string, key: string, delta: bigint): bigint;
  compareAndSwap(bucket: string, key: string, oldValue?: Uint8Array, newValue?: Uint8Array): boolean;
}
