import { Kv, KvConsistencyLevel, KvKey, KvListSelector } from '@deno/kv';
import {
  MaybeAsyncMap, MaybeAsyncMapBatch, RangeQueryOptions, RangeQueryable, rangeQueryable
} from '@mithic/collections';
import { AbortOptions, CodedError, DisposableCloseable, OperationError } from '@mithic/commons';

/** Deno {@link Kv} implementation of an async queryable map. */
export class DenoKVMap<K extends KvKey = KvKey, V = unknown>
  extends DisposableCloseable
  implements AsyncIterable<[K, V]>, MaybeAsyncMap<K, V>, MaybeAsyncMapBatch<K, V>, RangeQueryable<K, V>, Disposable {

  public constructor(
    /** Backing Kv storage. */
    protected readonly kv: Kv,
    /** Default consistency level for get operations. */
    protected readonly consistency: KvConsistencyLevel = 'strong',
  ) {
    super();
  }

  public close(): void {
    this.kv.close();
  }

  public async get<T extends V = V>(key: K, options?: DenoKVMapGetOptions): Promise<T | undefined> {
    const result = await this.kv.get<T>(key, { consistency: options?.consistency ?? this.consistency });
    return result.value !== null ? result.value : void 0;
  }

  public async set(key: K, value: V, options?: DenoKVMapSetOptions): Promise<void> {
    await this.kv.set(key, value, options);
  }

  public delete(key: K): Promise<void> {
    return this.kv.delete(key);
  }

  public async has(key: K, options?: DenoKVMapGetOptions): Promise<boolean> {
    return (await this.get(key, options) !== void 0);
  }

  public async * getMany<T extends V = V>(
    keys: Iterable<K>, options?: DenoKVMapGetOptions
  ): AsyncIterableIterator<T | undefined> {
    options?.signal?.throwIfAborted();
    const results = await this.kv.getMany<T[]>([...keys], { consistency: options?.consistency ?? this.consistency });
    for (const result of results) {
      options?.signal?.throwIfAborted();
      yield (result.value !== null ? result.value : void 0);
    }
  }

  public async * hasMany(keys: Iterable<K>, options?: DenoKVMapGetOptions): AsyncIterableIterator<boolean> {
    for await (const value of this.getMany(keys, options)) {
      yield value !== void 0;
    }
  }

  public setMany(
    entries: Iterable<[K, V]>, options?: DenoKVMapSetOptions
  ): AsyncIterableIterator<CodedError<K> | undefined> {
    return this.updateMany(entries, options);
  }

  public deleteMany(
    keys: Iterable<K>, options?: AbortOptions
  ): AsyncIterableIterator<CodedError<K> | undefined> {
    return this.updateMany([...keys].map((k) => [k]), options);
  }

  public async * updateMany(
    entries: Iterable<[K, V?]>, options?: DenoKVMapSetOptions
  ): AsyncIterableIterator<CodedError<K> | undefined> {
    let tx = this.kv.atomic();
    for (const [key, value] of entries) {
      if (value === void 0) {
        tx = tx.delete(key);
      } else {
        tx = tx.set(key, value, options);
      }
    }

    let error: unknown | undefined;
    options?.signal?.throwIfAborted();
    try {
      await tx.commit();
    } catch (e) {
      error = e;
    }

    for (const [key] of entries) {
      options?.signal?.throwIfAborted();
      if (error) {
        yield new OperationError('failed to update', { detail: key, cause: error });
      } else {
        yield;
      }
    }
  }

  public async * keys(options?: DenoKVMapRangeQueryOptions<K>): AsyncIterableIterator<K> {
    for await (const [key] of this.entries(options)) {
      yield key;
    }
  }

  public async * values(options?: DenoKVMapRangeQueryOptions<K>): AsyncIterableIterator<V> {
    for await (const [, value] of this.entries(options)) {
      yield value;
    }
  }

  public async * entries(options?: DenoKVMapRangeQueryOptions<K>): AsyncIterableIterator<[K, V]> {
    for await (const entry of this.kv.list<V>(toDenoKvListSelector(options), {
      batchSize: options?.batchSize,
      consistency: options?.consistency ?? this.consistency,
      limit: options?.limit,
      reverse: options?.reverse,
    })) {
      yield [entry.key as K, entry.value];
    }
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<[K, V]> {
    return this.entries();
  }

  public get [Symbol.toStringTag](): string {
    return DenoKVMap.name;
  }

  public get [rangeQueryable](): true {
    return true;
  }
}

/** Get options for a {@link DenoKVMap} */
export interface DenoKVMapGetOptions extends AbortOptions {
  /** Consistency level for get operations. */
  readonly consistency?: KvConsistencyLevel;
}

/** Set options for a {@link DenoKVMap} */
export interface DenoKVMapSetOptions extends AbortOptions {
  /** TTL in milliseconds. */
  readonly expireIn?: number;
}

/** Range query options for a {@link DenoKVMap} */
export interface DenoKVMapRangeQueryOptions<K> extends DenoKVMapGetOptions, RangeQueryOptions<K> {
  /** The size of the batches in which the query operation is performed. */
  readonly batchSize?: number;
}

function toDenoKvListSelector(options?: DenoKVMapRangeQueryOptions<KvKey>): KvListSelector {
  const lowerOpen = options?.lowerOpen ?? false;
  const upperOpen = options?.upperOpen ?? true;
  const lower = options?.lower === void 0 ? void 0 :
    lowerOpen ? [...options.lower, false] : options.lower;
  const upper = options?.upper === void 0 ? void 0 : 
    !upperOpen ? [...options.upper, false] : options.upper;

  return lower ? upper ? { start: lower, end: upper } : { prefix: [], start: lower } :
    upper ? { prefix: [], end: upper } : { prefix: [] };
}
