import { AppendOnlyAutoKeyMap, AutoKeyMapBatch } from '@mithic/collections';
import { AbortOptions, CodedError, ContentId, ErrorCode, MaybePromise, SyncOrAsyncGenerator, operationError } from '@mithic/commons';
import { Event } from './event.js';
import { EventStore, EventStoreQueryOptions } from './store.js';
import { DEFAULT_QUERY_PAGE_SIZE } from './defaults.js';

/** An abstract {@link EventStore} that stores events in an append-only auto-keyed map. */
export abstract class BaseMapEventStore<
  K = ContentId, V = Event, QueryExt = Record<string, never>
> implements EventStore<K, V, QueryExt>, AsyncIterable<[K, V]> {
  public constructor(
    protected readonly data: AppendOnlyAutoKeyMap<K, V> & Partial<AutoKeyMapBatch<K, V>>,
    protected readonly queryPageSize = DEFAULT_QUERY_PAGE_SIZE,
  ) {
  }

  public abstract keys(options?: (EventStoreQueryOptions<K> & QueryExt)): SyncOrAsyncGenerator<K, K[]>;

  public getKey(value: V, options?: AbortOptions): MaybePromise<K> {
    return this.data.getKey(value, options);
  }

  public get(key: K, options?: AbortOptions): MaybePromise<V | undefined> {
    return this.data.get(key, options);
  }

  public async * getMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<V | undefined> {
    if (this.data.getMany) {
      return yield* this.data.getMany(keys, options);
    } else {
      for (const key of keys) {
        yield this.get(key, options);
      }
    }
  }

  public has(key: K, options?: AbortOptions): MaybePromise<boolean> {
    return this.data.has(key, options);
  }

  public async * hasMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    if (this.data.hasMany) {
      return yield* this.data.hasMany(keys, options);
    } else {
      for (const key of keys) {
        yield this.has(key, options);
      }
    }
  }

  public put(value: V, options?: AbortOptions): MaybePromise<K> {
    return this.data.put(value, options);
  }

  public async * putMany(
    values: Iterable<V>, options?: AbortOptions
  ): AsyncIterableIterator<[key: K, error?: Error]> {
    for await (const value of values) {
      try {
        yield [await this.put(value, options)];
      } catch (error) {
        const key = await this.getKey(value);
        yield [
          key,
          error instanceof Error && (error as CodedError)?.code ?
            error : operationError('Failed to put', ErrorCode.OpFailed, key, error)
        ];
      }
    }
  }

  public async * entries(options?: (EventStoreQueryOptions<K> & QueryExt)): AsyncGenerator<[K, V], K[]> {
    const keys = this.keys(options);
    const buffer = [];
    let result;
    for (result = await keys.next(); !result.done; result = await keys.next()) {
      buffer.push(result.value);
      if (buffer.length >= this.queryPageSize) {
        yield* this.entriesForKeys(buffer, options);
        buffer.length = 0;
      }
    }
    if (buffer.length) {
      yield* this.entriesForKeys(buffer, options);
    }
    return result.value;
  }

  public async * values(options?: (EventStoreQueryOptions<K> & QueryExt)): AsyncGenerator<V, K[]> {
    const entries = this.entries(options);
    let result;
    for (result = await entries.next(); !result.done; result = await entries.next()) {
      yield result.value[1];
    }
    return result.value;
  }

  public [Symbol.asyncIterator](): AsyncIterator<[K, V]> {
    return this.entries();
  }

  protected async * entriesForKeys(keys: K[], options?: AbortOptions): AsyncGenerator<[K, V]> {
    let i = 0;
    for await (const value of this.getMany(keys, options)) {
      if (value) {
        yield [keys[i], value];
      }
      ++i;
    }
  }
}
