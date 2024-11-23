import { dispose, MaybePromise } from '@mithic/commons';
import { KeyValue } from './keyvalue.ts';
import type { KeyValueStore } from './service.ts';
import { type KeyResponse } from './types.ts';

/**
 * Get the bucket with the specified URI.
 * @throws {@link StoreError}
 */
export function open(identifier: string): MaybePromise<Bucket> {
  return MaybePromise.map(KeyValue.provider.open(identifier), newBucket);
}

/** A collection of key-value pairs. */
export class Bucket implements Disposable {
  /** The underlying store. */
  public readonly store: KeyValueStore;

  public constructor(
    /** The underlying store. */
    store: KeyValueStore
  ) {
    this.store = store;
  }

  public [Symbol.dispose]() {
    dispose(this.store);
  }

  /**
   * Get the value associated with the specified `key`.
   * @throws {@link StoreError}
   */
  public get(key: string): MaybePromise<Uint8Array | undefined> {
    return MaybePromise.map(this.store.getMany([key]), getFirst);
  }

  /**
   * Set the value associated with the key in the store.
   * If the key already exists in the store, it overwrites the value.
   * @throws {@link StoreError}
   */
  public set(key: string, value: Uint8Array): MaybePromise<void> {
    return this.store.updateMany([[key, value]]);
  }

  /**
   * Delete the key-value pair associated with the key in the store.
   * If the key does not exist in the store, it does nothing.
   * @throws {@link StoreError}
   */
  public delete(key: string): MaybePromise<void> {
    return this.store.updateMany([[key, null]]);
  }

  /**
   * Check if the key exists in the store.
   * @throws {@link StoreError}
   */
  public exists(key: string): MaybePromise<boolean> {
    return this.store.exists(key);
  }

  /**
   * Get all keys in the store unordered with an optional cursor for pagination.
   * Note: May show out-of-date keys if there are concurrent writes.
   * @throws {@link StoreError}
   */
  public listKeys(cursor?: string): MaybePromise<KeyResponse> {
    return this.store.listKeys(undefined, cursor);
  }
}

function newBucket(store: KeyValueStore): Bucket {
  return new Bucket(store);
}

function getFirst<T>(values: (T | null)[]): T | undefined {
  return values[0] ?? undefined;
}
