import { type Bucket } from './store.ts';

/**
 * Atomically increment the value associated with the key in the store by the given delta. It returns the new value.
 * If the key does not exist in the store, it creates a new key-value pair with the value set to the given delta.
 * @throws {@link StoreError}
 */
export function increment(bucket: Bucket, key: string, delta: bigint): bigint {
  return bucket.provider.increment(bucket.bucket, key, delta);
}

/** 
 * Atomically set the value associated with the key in the store to the given value.
 * It returns `true` if the value was set properly, or `false` if the swap failed.
 * @throws {@link StoreError}
 */
export function compareAndSwap(bucket: Bucket, key: string, oldValue?: Uint8Array, newValue?: Uint8Array): boolean {
  return bucket.provider.compareAndSwap(bucket.bucket, key, oldValue, newValue);
}
