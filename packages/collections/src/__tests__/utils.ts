import { SyncOrAsyncIterable } from '@mithic/commons';
import { CID } from 'multiformats';
import { identity } from 'multiformats/hashes/identity';

export function createCID(data: Uint8Array): CID {
  return CID.createV1(0x55, identity.digest(data));
}

export async function collect<T>(entries: SyncOrAsyncIterable<T>): Promise<T[]> {
  const results = [];
  for await (const entry of entries) {
    results.push(entry);
  }
  return results;
}
