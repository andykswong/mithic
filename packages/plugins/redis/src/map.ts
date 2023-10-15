import { MaybeAsyncMap, MaybeAsyncMapBatch, RangeQueryOptions, RangeQueryable } from '@mithic/collections';
import { AbortOptions, AsyncDisposableCloseable, CodedError, OperationError, Startable } from '@mithic/commons';
import { commandOptions, RedisClientType } from '@redis/client';
import { RedisValueType } from './type.js';

/** Redis implementation of an async queryable map. */
export class RedisMap<UseBuffer extends boolean = false, R extends RedisClientType = RedisClientType>
  extends AsyncDisposableCloseable
  implements AsyncIterable<[string, RedisValueType<UseBuffer>]>, MaybeAsyncMap<string, RedisValueType<UseBuffer>>,
  MaybeAsyncMapBatch<string, RedisValueType<UseBuffer>>, RangeQueryable<string, RedisValueType<UseBuffer>>,
  Startable, AsyncDisposable {

  public constructor(
    /** Redis client to use. */
    protected readonly client: R,
    /** Key used to store the hash map. */
    protected readonly hashKey: string,
    /** Key used to store the sorted set index. */
    protected readonly rangeKey: string,
    /** Whether to use buffers or strings as values. */
    protected readonly useBuffer?: UseBuffer,
  ) {
    super();
  }

  public get started(): boolean {
    return this.client.isReady;
  }

  public async start(): Promise<void> {
    await this.client.connect();
  }

  public async close(): Promise<void> {
    await this.client.quit();
  }

  public async get(key: string, options?: AbortOptions): Promise<RedisValueType<UseBuffer> | undefined> {
    return await this.client.hGet(
      commandOptions({ returnBuffers: this.useBuffer, ...options }),
      this.hashKey, key
    );
  }

  public async has(key: string, options: AbortOptions = {}): Promise<boolean> {
    return (await this.client.hGet(commandOptions(options), this.hashKey, key) !== void 0);
  }

  public async set(key: string, value: RedisValueType<UseBuffer>): Promise<void> {
    await this.client.multi()
      .hSet(this.hashKey, key, value)
      .zAdd(this.rangeKey, { value: key, score: 0 })
      .exec();
  }

  public async delete(key: string): Promise<boolean> {
    const [deleted] = await this.client.multi()
      .hDel(this.hashKey, key)
      .zRem(this.rangeKey, key)
      .exec();
    return !!deleted;
  }

  public async * getMany(keys: Iterable<string>, options?: AbortOptions): AsyncIterableIterator<RedisValueType<UseBuffer> | undefined> {
    yield* await this.client.hmGet(
      commandOptions({ returnBuffers: this.useBuffer, ...options }),
      this.hashKey, [...keys]
    );
  }

  public async * hasMany(keys: Iterable<string>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    for await (const key of this.getMany(keys, options)) {
      yield key !== void 0;
    }
  }

  public async * setMany(entries: Iterable<[string, RedisValueType<UseBuffer>]>): AsyncIterableIterator<CodedError<string> | undefined> {
    let error: unknown | undefined;
    try {
      const entryArray = [...entries];
      await this.client.multi()
        .hSet(this.hashKey, entryArray)
        .zAdd(this.rangeKey, entryArray.map(([key]) => ({ value: key, score: 0 })))
        .exec();
    } catch (e) {
      error = e;
    }
    for (const [key] of entries) {
      if (error === void 0) {
        yield;
      } else {
        yield new OperationError('failed to set', { code: (error as CodedError)?.code, detail: key, cause: error });
      }
    }
  }

  public async * deleteMany(keys: Iterable<string>): AsyncIterableIterator<CodedError<string> | undefined> {
    let error: unknown | undefined;
    try {
      const keyArray = [...keys];
      await this.client.multi()
        .hDel(this.hashKey, keyArray)
        .zRem(this.rangeKey, keyArray)
        .exec();
    } catch (e) {
      error = e;
    }
    for (const key of keys) {
      if (error === void 0) {
        yield;
      } else {
        yield new OperationError('failed to delete', { code: (error as CodedError)?.code, detail: key, cause: error });
      }
    }
  }

  public async * updateMany(
    entries: Iterable<[string, RedisValueType<UseBuffer>?]>
  ): AsyncIterableIterator<Error | undefined> {
    let error: unknown | undefined;
    try {
      const addedEntries: [string, RedisValueType<UseBuffer>][] = [];
      const deletedKeys = [];
      for (const [key, value] of entries) {
        if (value === void 0) {
          deletedKeys.push(key);
        } else {
          addedEntries.push([key, value]);
        }
      }

      await this.client.multi()
        .hSet(this.hashKey, addedEntries)
        .hDel(this.hashKey, deletedKeys)
        .zAdd(this.rangeKey, addedEntries.map(([key]) => ({ value: key, score: 0 })))
        .zRem(this.rangeKey, deletedKeys)
        .exec();
    } catch (e) {
      error = e;
    }
    for (const [key] of entries) {
      if (error === void 0) {
        yield;
      } else {
        yield new OperationError('failed to update', { code: (error as CodedError)?.code, detail: key, cause: error });
      }
    }
  }

  public async * entries(options?: RangeQueryOptions<string>): AsyncIterableIterator<[string, RedisValueType<UseBuffer>]> {
    const keys = await this.query(options);
    const values = await this.client.hmGet(
      commandOptions({ returnBuffers: this.useBuffer, signal: options?.signal }),
      this.hashKey, keys
    );
    for (let i = 0; i < keys.length; i++) {
      yield [keys[i], values[i]];
    }
  }

  public async * keys(options?: RangeQueryOptions<string>): AsyncIterableIterator<string> {
    yield* await this.query(options);
  }

  public async * values(options?: RangeQueryOptions<string>): AsyncIterableIterator<RedisValueType<UseBuffer>> {
    yield* await this.client.hmGet(
      commandOptions({ returnBuffers: this.useBuffer, signal: options?.signal }),
      this.hashKey, await this.query(options)
    );
  }

  public [Symbol.asyncIterator](): AsyncIterator<[string, RedisValueType<UseBuffer>]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return RedisMap.name;
  }

  protected query(options?: RangeQueryOptions<string>): Promise<string[]> {
    let start = options?.gte ? '[' + options.gte : options?.gt ? '(' + options.gt : '-';
    let end = options?.lte ? '[' + options.lte : options?.lt ? '(' + options.lt : '+';
    if (options?.reverse) {
      [start, end] = [end, start];
    }

    return this.client.zRange(
      commandOptions({ signal: options?.signal }),
      this.rangeKey,
      start, end,
      {
        BY: 'LEX',
        REV: options?.reverse ? true : void 0,
        LIMIT: options?.limit ? { offset: 0, count: options.limit } : void 0
      }
    );
  }
}
