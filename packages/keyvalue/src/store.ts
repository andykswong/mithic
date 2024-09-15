import { KeyValue, type KeyValueApiProvider } from './provider/index.ts';
import { type KeyResponse } from './types.ts';

/**
 * Get the bucket with the specified URI.
 * @throws {@link StoreError}
 */
export function open(identifier: string): Bucket {
  return new Bucket(KeyValue.provider, identifier);
}

/** A collection of key-value pairs. */
export class Bucket implements Disposable {
  /** The API provider. */
  public readonly provider: KeyValueApiProvider;
  /** The bucket identifier. */
  public readonly identifier: string;
  public readonly bucket: string;

  public constructor(
    /** The API provider. */
    provider: KeyValueApiProvider,
    /** The bucket identifier. */
    identifier: string,
  ) {
    this.provider = provider;
    this.identifier = identifier;
    this.bucket = provider.open(identifier);
  }

  public [Symbol.dispose]() {
    this.provider.close(this.bucket);
  }

  /**
   * Get the value associated with the specified `key`.
   * @throws {@link StoreError}
   */
  public get(key: string): Uint8Array | undefined {
    for (const result of this.provider.getMany(this.bucket, [key])) {
      if (result !== null) {
        return result;
      }
      break;
    }
  }

  /**
   * Set the value associated with the key in the store. If the key already
   * exists in the store, it overwrites the value.
   * @throws {@link StoreError}
   */
  public set(key: string, value: Uint8Array): void {
    this.provider.updateMany(this.bucket, [[key, value]]);
  }

  /**
   * Delete the key-value pair associated with the key in the store.
   * If the key does not exist in the store, it does nothing.
   * @throws {@link StoreError}
   */
  public delete(key: string): void {
    this.provider.updateMany(this.bucket, [[key, null]]);
  }

  /**
   * Check if the key exists in the store.
   * @throws {@link StoreError}
   */
  public exists(key: string): boolean {
    return this.provider.exists(this.bucket, key);
  }

  /**
   * Get all keys in the store unordered with an optional cursor for pagination.
   * Note: May show out-of-date keys if there are concurrent writes.
   * @throws {@link StoreError}
   */
  public listKeys(cursor?: string): KeyResponse {
    return this.provider.listKeys(this.bucket, undefined, cursor);
  }
}
