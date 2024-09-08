import { type Bucket } from './store.ts';

/**
 * Get the key-value pairs associated with the keys in the store.
 * @throws {@link StoreError}
 */
export function getMany(bucket: Bucket, keys: string[]): ([key: string, value: Uint8Array] | undefined)[] {
  const results = Array(keys.length).fill(undefined);
  if (!keys.length) { return results; }
  let i = 0;
  for (const value of bucket.provider.getMany(bucket.bucket, keys)) {
    if (value) {
      results[i] = [keys[i], value];
    }
    ++i;
  }
  return results;
}

/** 
 * Set the values associated with the keys in the store.
 * If the key already exists in the store, it overwrites the value.
 * @throws {@link StoreError}
 */
export function setMany(bucket: Bucket, keyValues: [key: string, value: Uint8Array][]): void {
  if (!keyValues.length) { return; }
  bucket.provider.updateMany(bucket.bucket, keyValues);
}

/** 
 * Delete the key-value pairs associated with the keys in the store.
 * @throws {@link StoreError}
 */
export function deleteMany(bucket: Bucket, keys: string[]): void {
  if (!keys.length) { return; }
  const keyValues = keys.map(keyTokeyValue);
  bucket.provider.updateMany(bucket.bucket, keyValues);
}

function keyTokeyValue(key: string): [string, null] {
  return [key, null];
}
