import { type Bucket } from './store.ts';
import { type KeyResponse, type KeySelector } from './types.ts';

/**
 * An extended `list-keys` operation that, given a key range, returns matching keys in the store
 * in lexicographical order, with an optional cursor for pagination.
 * @throws {@link StoreError}
 */
export function listKeys(bucket: Bucket, selector?: KeySelector, cursor?: string): KeyResponse {
  return bucket.provider.listKeys(bucket.bucket, selector, cursor);
}
