import { AppendOnlyAutoKeyMap, AutoKeyMapBatch, Batch } from '@mithic/collections';
import {
  AbortOptions, CodedError, ContentId, ErrorCode, MaybePromise, SyncOrAsyncGenerator, operationError
} from '@mithic/commons';
import { EventStore, EventStorePutOptions, EventStoreQueryOptions } from '../store.js';
import { DEFAULT_BATCH_SIZE } from '../defaults.js';

/**
 * An abstract {@link EventStore} that stores events in an append-only auto-keyed map.
 * One of `entries` or `keys` query functions must be overridden in subclass, as by default they refer to each other.
 */
export abstract class BaseMapEventStore<
  K = ContentId, V = unknown, QueryExt extends object = NonNullable<unknown>
> implements EventStore<K, V, QueryExt>, AsyncIterable<[K, V]> {
  public constructor(
    protected readonly data: AppendOnlyAutoKeyMap<K, V> & Partial<AutoKeyMapBatch<K, V>>,
    protected readonly queryPageSize = DEFAULT_BATCH_SIZE,
  ) {
  }

  /** Hook to do extra processing before putting an event value to store. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected prePut(value: V, options?: AbortOptions): MaybePromise<V> {
    return value;
  }

  public async validate(value: V, options?: AbortOptions): Promise<CodedError<K[]> | undefined> {
    const key = await this.data.getKey(value, options);
    if (await this.data.has(key, options)) {
      return operationError('Already exists', ErrorCode.Exist, [key]);
    }
  }

  public getKey(value: V, options?: AbortOptions): MaybePromise<K> {
    return this.data.getKey(value, options);
  }

  public get(key: K, options?: AbortOptions): MaybePromise<V | undefined> {
    return this.data.get(key, options);
  }

  public getMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<V | undefined> {
    return Batch.getMany(this.data, keys, options);
  }

  public has(key: K, options?: AbortOptions): MaybePromise<boolean> {
    return this.data.has(key, options);
  }

  public hasMany(keys: Iterable<K>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    return Batch.hasMany(this.data, keys, options);
  }

  public async put(value: V, options?: EventStorePutOptions): Promise<K> {
    if (options?.validate ?? true) {
      const error = await this.validate(value, options);
      if (error) {
        if (error.code === ErrorCode.Exist) {
          return (error.detail as K[])[0];
        }
        throw error;
      }
    }
    return this.data.put(await this.prePut(value, options), options);
  }

  public async * putMany(
    values: Iterable<V>, options?: EventStorePutOptions
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

  public async * entries(options?: EventStoreQueryOptions<K> & QueryExt): SyncOrAsyncGenerator<[K, V], K[]> {
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

  public async * keys(options?: EventStoreQueryOptions<K> & QueryExt): SyncOrAsyncGenerator<K, K[]> {
    const entries = this.entries(options);
    let result;
    for (result = await entries.next(); !result.done; result = await entries.next()) {
      yield result.value[0];
    }
    return result.value;
  }

  public async * values(options?: EventStoreQueryOptions<K> & QueryExt): SyncOrAsyncGenerator<V, K[]> {
    const entries = this.entries(options);
    let result;
    for (result = await entries.next(); !result.done; result = await entries.next()) {
      yield result.value[1];
    }
    return result.value;
  }

  public async *[Symbol.asyncIterator](): AsyncIterableIterator<[K, V]> {
    yield* this.entries();
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
