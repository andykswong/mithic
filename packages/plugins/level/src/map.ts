import { MaybeAsyncMap, MaybeAsyncMapBatch, RangeQueryOptions, RangeQueryable } from '@mithic/collections';
import { AbortOptions, CodedError, ErrorCode, Startable, operationError } from '@mithic/commons';
import { AbstractLevel, AbstractOpenOptions } from 'abstract-level';

const LEVEL_NOT_FOUND = 'LEVEL_NOT_FOUND';

/** {@link AbstractLevel} implementation of an async queryable map. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class LevelMap<K, V, T = any>
  implements AsyncIterable<[K, V]>, MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V>, RangeQueryable<K, V>, Startable {

  private opened: boolean;

  public constructor(
    /** Backing AbstractLevel storage. */
    protected readonly level: AbstractLevel<T, K, V>,
  ) {
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

  public async * getMany(keys: Iterable<K>): AsyncIterableIterator<V> {
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
        yield operationError('Failed to delete', ErrorCode.OpFailed, key, error);
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
        yield operationError('Failed to delete', ErrorCode.OpFailed, key, error);
      } else {
        yield;
      }
    }
  }

  public async * keys(options: RangeQueryOptions<K> = {}): AsyncIterableIterator<K> {
    yield* this.level.keys(options);
  }

  public async * values(options: RangeQueryOptions<K> = {}): AsyncIterableIterator<V> {
    yield* this.level.values(options);
  }

  public async * entries(options: RangeQueryOptions<K> = {}): AsyncIterableIterator<[K, V]> {
    yield* this.level.iterator(options);
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<[K, V]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return LevelMap.name;
  }
}
