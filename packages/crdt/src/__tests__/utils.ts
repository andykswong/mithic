import { SyncOrAsyncIterable } from '@mithic/commons';

export async function collect<T>(entries: SyncOrAsyncIterable<T>): Promise<T[]> {
  const results = [];
  for await (const entry of entries) {
    results.push(entry);
  }
  return results;
}
