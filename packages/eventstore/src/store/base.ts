import { AppendOnlyAutoKeyMap, AutoKeyMapBatch } from '@mithic/collections';
import {
  AbortOptions, CodedError, ContentId, ErrorCode, MaybePromise, StringEquatable, SyncOrAsyncGenerator,
  equalsOrSameString, operationError
} from '@mithic/commons';
import { Event, EventMetadata } from '../event.js';
import { EventStore, EventStoreQueryOptions } from '../store.js';
import { DEFAULT_BATCH_SIZE } from '../defaults.js';

/**
 * An abstract {@link EventStore} that stores events in an append-only auto-keyed map.
 * One of `entries` or `keys` query functions must be overridden in subclass, as by default they refer to each other.
 * `put` is usually overridden by subclass to prepare event indices for efficient queries.
 */
export abstract class BaseMapEventStore<
  K = ContentId, V = Event, QueryExt extends object = NonNullable<unknown>
> implements EventStore<K, V, QueryExt>, AsyncIterable<[K, V]> {
  public constructor(
    protected readonly data: AppendOnlyAutoKeyMap<K, V> & Partial<AutoKeyMapBatch<K, V>>,
    protected readonly queryPageSize = DEFAULT_BATCH_SIZE,
  ) {
  }

  /** Hook to do extra processing before putting an event value to store. */
  protected prePut(_value: V, _options?: AbortOptions): MaybePromise<void> {
    // NOOP
  }

  /** Validates given event and returns any error. */
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

  public async put(value: V, options?: AbortOptions): Promise<K> {
    const error = await this.validate(value, options);
    if (error) {
      if (error.code === ErrorCode.Exist) {
        return (error.detail as K[])[0];
      }
      throw error;
    }
    await this.prePut(value, options);
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

/** An abstract {@link EventStore} storing events that form a DAG. */
export abstract class BaseDagEventStore<
  K extends StringEquatable<K> = ContentId,
  V extends Event<unknown, EventMetadata<K>> = Event<unknown, EventMetadata<K>>,
  QueryExt extends object = NonNullable<unknown>
> extends BaseMapEventStore<K, V, QueryExt> {
  /** Cache of event parents during a put operation. */
  protected currentEventDeps: [K, V][] = [];
  private useCache = false;

  public constructor(
    protected readonly data: AppendOnlyAutoKeyMap<K, V> & Partial<AutoKeyMapBatch<K, V>>,
    protected readonly queryPageSize = DEFAULT_BATCH_SIZE,
  ) {
    super(data, queryPageSize);
  }

  public async validate(value: V, options?: AbortOptions): Promise<CodedError<K[]> | undefined> {
    const error = await super.validate(value, options);
    if (error) {
      return error;
    }

    const rootId = value.meta.root;

    if (!value.meta.parents.length) {
      if (rootId != void 0) { // if specified, root Id must be a dependency
        return operationError('Missing dependency to root Id', ErrorCode.MissingDep, [rootId]);
      }
      return;
    }

    if (rootId == void 0) { // root Id must be specified if there are dependencies
      return operationError('Missing root Id', ErrorCode.InvalidArg);
    }

    const parents = this.useCache ? this.currentEventDeps : [];
    parents.length = 0;

    const missing: K[] = [];
    let hasLinkToRoot = false;
    let i = 0;
    for await (const parent of this.getMany(value.meta.parents, options)) {
      const key = value.meta.parents[i++];
      if (!parent) {
        missing.push(key);
        continue;
      }
      parents.push([key, parent]);
      hasLinkToRoot = hasLinkToRoot ||
        (parent.meta.root != void 0 && equalsOrSameString(rootId, parent.meta.root)) ||
        equalsOrSameString(rootId, key);
    }

    if (missing.length) {
      return operationError('Missing dependencies', ErrorCode.MissingDep, missing);
    }

    if (!hasLinkToRoot) { // root Id must match one of parents' root
      return operationError('Missing dependency to root Id', ErrorCode.MissingDep, [rootId]);
    }
  }

  public async put(value: V, options?: AbortOptions): Promise<K> {
    try {
      this.useCache = true;
      this.currentEventDeps.length = 0;
      return await super.put(value, options);
    } finally {
      this.useCache = false;
      this.currentEventDeps.length = 0;
    }
  }
}
