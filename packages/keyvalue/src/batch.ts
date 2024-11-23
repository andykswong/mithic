import { MaybePromise } from '@mithic/commons';
import type { Bucket } from './store.ts';

/**
 * Get the key-value pairs associated with the keys in the store.
 * @throws {@link StoreError}
 */
export function getMany(bucket: Bucket, keys: string[]): MaybePromise<([key: string, value: Uint8Array] | undefined)[]> {
  const results = Array(keys.length).fill(undefined);
  if (!keys.length) { return results; }
  return MaybePromise.map(bucket.store.getMany(keys), (values) => zipKeyValues(keys, values));
}

/** 
 * Set the values associated with the keys in the store.
 * If the key already exists in the store, it overwrites the value.
 * @throws {@link StoreError}
 */
export function setMany(bucket: Bucket, keyValues: [key: string, value: Uint8Array][]): MaybePromise<void> {
  if (!keyValues.length) { return; }
  return bucket.store.updateMany(keyValues);
}

/** 
 * Delete the key-value pairs associated with the keys in the store.
 * @throws {@link StoreError}
 */
export function deleteMany(bucket: Bucket, keys: string[]): MaybePromise<void> {
  if (!keys.length) { return; }
  const keyValues = keys.map(keyToKeyValue);
  return bucket.store.updateMany(keyValues);
}

function zipKeyValues(keys: string[], values: (Uint8Array | null)[]): ([string, Uint8Array] | undefined)[] {
  const results = Array(keys.length).fill(undefined);
  for (let i = 0; i < values.length; ++i) {
    if (values[i]) {
      results[i] = [keys[i], values[i]];
    }
  }
  return results;
}

function keyToKeyValue(key: string): [string, null] {
  return [key, null];
}
