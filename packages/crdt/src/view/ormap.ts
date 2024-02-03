import {
  MaybeAsyncReadonlyMap, MaybeAsyncReadonlyMapBatch, RangeQueryOptions, RangeQueryable, ReadonlyTripleStore, rangeQueryable
} from '@mithic/collections';
import { AbortOptions, ContentId, MaybePromise } from '@mithic/commons';
import { ReadonlyLSeq } from './lseq.ts';
import { ReadonlyORSet } from './orset.ts';
import { defaultStringify } from '../defaults.ts';

/** Readonly observed-removed map. */
export class ReadonlyORMap<V = unknown, Id = ContentId>
  implements MaybeAsyncReadonlyMap<string, V>, MaybeAsyncReadonlyMapBatch<string, V>,
  RangeQueryable<string, V>, AsyncIterable<[string, V]>
{
  public constructor(
    /** The underlying store. */
    protected readonly store: ReadonlyTripleStore<Id, V>,
    /** The map entity ID. */
    public readonly entityId: Id,
    /** Function for converting value to hash string. */
    protected readonly stringify: (value: V, options?: AbortOptions) => MaybePromise<string> = defaultStringify,
  ) { }

  public getList(key: string): ReadonlyLSeq<V, Id> {
    return new ReadonlyLSeq(this.store, this.entityId, key);
  }

  public getSet(key: string): ReadonlyORSet<V, Id> {
    return new ReadonlyORSet(this.store, this.entityId, key, this.stringify);
  }

  public async get(key: string, options?: AbortOptions): Promise<V | undefined> {
    for await (const [, value] of this.store.entries({
      ...options,
      lower: [this.entityId, key],
      upper: [this.entityId, key],
      upperOpen: false,
      limit: 1,
    })) {
      return value;
    }
  }

  public async has(key: string, options?: AbortOptions): Promise<boolean> {
    return (await this.get(key, options)) !== void 0;
  }

  public async * getMany(keys: Iterable<string>, options?: AbortOptions): AsyncIterableIterator<V | undefined> {
    for await (const iter of this.store.findMany([...keys].map((key) => [this.entityId, key]), options)) {
      const result = await iter.next();
      yield result.done ? void 0 : result.value[1];
    }
  }

  public async * hasMany(keys: Iterable<string>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    for await (const value of this.getMany(keys, options)) { yield value !== void 0; }
  }

  public async * entries(options?: RangeQueryOptions<string>): AsyncIterableIterator<[string, V]> {
    for await (const [[, field], value] of this.store.entries({
      ...options,
      lower: [this.entityId, options?.lower ?? ''],
      upper: [this.entityId, options?.upper],
      upperOpen: options?.upper !== void 0 && (options?.upperOpen ?? true)
    })) {
      yield [field, value];
    }
  }

  public async * keys(options?: RangeQueryOptions<string>): AsyncIterableIterator<string> {
    for await (const [key] of this.entries(options)) { yield key; }
  }

  public async * values(options?: RangeQueryOptions<string>): AsyncIterableIterator<V> {
    for await (const [, value] of this.entries(options)) { yield value; }
  }

  public [Symbol.asyncIterator](): AsyncIterator<[string, V]> {
    return this.entries();
  }

  public get [rangeQueryable](): true {
    return true;
  }

  public get [Symbol.toStringTag](): string {
    return ReadonlyORMap.name;
  }
}
