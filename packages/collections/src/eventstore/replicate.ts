import { AbortOptions } from '@mithic/commons';
import { DEFAULT_BATCH_SIZE } from './defaults.ts';
import { EventStoreQuery, EventStoreQueryOptions } from '../eventstore.ts';
import { AutoKeyMapPutBatch } from '../map.ts';
import { MaybeAsyncReadonlySetBatch } from '../set.ts';

/** Simple helper function to replicate source events to target store and return the latest checkpoint. */
export async function replicateEvents<K, V, QueryExt extends object>({
  source, target, since, limit, signal, extra, batchSize = DEFAULT_BATCH_SIZE,
}: ReplicateEventsOptions<K, V, QueryExt>): Promise<K[]> {
  const iter = source.entries({ since, limit, signal, ...extra } as EventStoreQueryOptions<K> & QueryExt);
  const abortOptions = { signal };
  let result;
  const keys = [];
  const values = [];
  for (result = await iter.next(); !result.done; result = await iter.next()) {
    keys.push(result.value[0])
    values.push(result.value[1]);
    if (keys.length >= batchSize) {
      await putMany(target, keys, values, abortOptions);
      keys.length = 0;
      values.length = 0;
    }
  }

  if (keys.length) {
    await putMany(target, keys, values, abortOptions);
  }

  return result.value;
}

/** Options of a {@link replicateEvents} call. */
export interface ReplicateEventsOptions<K, V, QueryExt extends object> extends AbortOptions {
  /** Local event store to replicate from. */
  source: EventStoreQuery<K, V, QueryExt>;

  /** Remote event store to replicate to. */
  target: AutoKeyMapPutBatch<K, V> & MaybeAsyncReadonlySetBatch<K>;

  /** Last checkpoint to start replication from. */
  since?: K[];

  /** Number of events to push at a time. */
  batchSize?: number;

  /** Maximum number of events to replicate. */
  limit?: number;

  /** Extra query parameters to filter events. */
  extra?: QueryExt;
}

async function putMany<K, V>(
  map: AutoKeyMapPutBatch<K, V> & MaybeAsyncReadonlySetBatch<K>, keys: K[], values: V[], options: AbortOptions
): Promise<void> {
  const newValues = [];
  let i = 0;
  for await (const exist of map.hasMany(keys, options)) {
    if (!exist) {
      newValues.push(values[i]);
    }
    ++i;
  }

  for await (const [, error] of map.putMany(newValues, options)) {
    // TODO: handle missing keys and other errors?
    if (error) {
      throw error;
    }
  }
}
