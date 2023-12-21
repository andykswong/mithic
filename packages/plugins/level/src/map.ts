import {
  MaybeAsyncMap, MaybeAsyncMapBatch, RangeQueryOptions, RangeQueryable, rangeQueryable
} from '@mithic/collections';
import { AbortOptions, AsyncDisposableCloseable, CodedError, OperationError, Startable } from '@mithic/commons';
import { AbstractLevel, AbstractOpenOptions } from 'abstract-level';

const LEVEL_NOT_FOUND = 'LEVEL_NOT_FOUND';

/** {@link AbstractLevel} implementation of an async queryable map. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class LevelMap<K, V, T = any>
  extends AsyncDisposableCloseable
  implements AsyncIterable<[K, V]>, MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V>, RangeQueryable<K, V>,
  Startable, AsyncDisposable {

  private opened: boolean;

  public constructor(
    /** Backing AbstractLevel storage. */
    protected readonly level: AbstractLevel<T, K, V>,
  ) {
    super();
    this.opened = level.status === 'open';
  }

  public get started(): boolean {
    return this.opened;
  }

  public async start(options: AbortOptions & AbstractOpenOptions = {}): Promise<void> {
    await this.level.open(options);
    this.opened = true;
  }

  public async close(): Promise<void> {
    await this.level.close();
    this.opened = false;
  }

  /** Clears the given range of entries or the entire store. */
  public clear(options: RangeQueryOptions<K> = {}): Promise<void> {
    return this.level.clear(options);
  }

  public async get(key: K): Promise<V | undefined> {
    try {
      return await this.level.get(key);
    } catch (e) {
      if ((e as CodedError)?.code === LEVEL_NOT_FOUND) {
        return void 0;
      }
      throw e;
    }
  }

  public set(key: K, value: V): Promise<void> {
    return this.level.put(key, value);
  }

  public delete(key: K): Promise<void> {
    return this.level.del(key);
  }

  public async has(key: K): Promise<boolean> {
    return (await this.get(key) !== void 0);
  }

  public async * getMany(keys: Iterable<K>): AsyncIterableIterator<V | undefined> {
    yield* await this.level.getMany([...keys]);
  }

  public async * hasMany(keys: Iterable<K>): AsyncIterableIterator<boolean> {
    for await (const value of this.getMany(keys)) {
      yield value !== void 0;
    }
  }

  public async * setMany(entries: Iterable<[K, V]>): AsyncIterableIterator<CodedError<K> | undefined> {
    let batch = this.level.batch();
    for (const [key, value] of entries) {
      batch = batch.put(key, value);
    }

    let error: unknown | undefined;
    try {
      await batch.write();
    } catch (e) {
      error = e;
    }

    for (const [key] of entries) {
      if (error) {
        yield new OperationError('failed to set', { detail: key, cause: error });
      } else {
        yield;
      }
    }
  }

  public async * deleteMany(keys: Iterable<K>): AsyncIterableIterator<CodedError<K> | undefined> {
    let batch = this.level.batch();
    for (const key of keys) {
      batch = batch.del(key);
    }

    let error: unknown | undefined;
    try {
      await batch.write();
    } catch (e) {
      error = e;
    }

    for (const key of keys) {
      if (error) {
        yield new OperationError('failed to delete', { detail: key, cause: error });
      } else {
        yield;
      }
    }
  }

  public async * updateMany(entries: Iterable<[K, V?]>): AsyncIterableIterator<Error | undefined> {
    let batch = this.level.batch();
    for (const [key, value] of entries) {
      if (value === void 0) {
        batch = batch.del(key);
      } else {
        batch = batch.put(key, value);
      }
    }

    let error: unknown | undefined;
    try {
      await batch.write();
    } catch (e) {
      error = e;
    }

    for (const [key] of entries) {
      if (error) {
        yield new OperationError('failed to update', { detail: key, cause: error });
      } else {
        yield;
      }
    }
  }

  public async * keys(options: RangeQueryOptions<K> = {}): AsyncIterableIterator<K> {
    yield* this.level.keys(toLevelDBRangeOptions(options));
  }

  public async * values(options: RangeQueryOptions<K> = {}): AsyncIterableIterator<V> {
    yield* this.level.values(toLevelDBRangeOptions(options));
  }

  public async * entries(options: RangeQueryOptions<K> = {}): AsyncIterableIterator<[K, V]> {
    yield* this.level.iterator(toLevelDBRangeOptions(options));
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<[K, V]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return LevelMap.name;
  }

  public get [rangeQueryable](): true {
    return true;
  }
}

function toLevelDBRangeOptions<K>(options: RangeQueryOptions<K>) {
  const { lower, upper, lowerOpen = false, upperOpen = true, reverse = false, limit } = options;
  const result: Record<string, unknown> = { reverse, limit };
  if (lower !== void 0) {
    if (lowerOpen) {
      result.gt = lower;
    } else {
      result.gte = lower;
    }
  }
  if (upper !== void 0) {
    if (upperOpen) {
      result.lt = upper;
    } else {
      result.lte = upper;
    }
  }
  return result;
}
