import {
  MaybeAsyncReadonlyMap, MaybeAsyncReadonlyMapBatch, RangeQueryOptions, RangeQueryable, rangeQueryable
} from '@mithic/collections';
import { AbortOptions, ContentId } from '@mithic/commons';
import { EntityAttrSearchKey, ReadonlyTripleStore } from '@mithic/triplestore';

/** Readonly observed-removed list. */
export class ReadonlyLSeq<V = unknown, Id = ContentId>
  implements MaybeAsyncReadonlyMap<string, V>, MaybeAsyncReadonlyMapBatch<string, V>,
  RangeQueryable<string, V>, AsyncIterable<V>
{
  public constructor(
    /** The underlying store. */
    protected readonly store: ReadonlyTripleStore<Id, V>,
    /** The set entity ID. */
    public readonly entityId: Id,
    /** Attribute name that holds this list. */
    public readonly attr: string,
  ) { }

  public async get(index: string, options?: AbortOptions): Promise<V | undefined> {
    for await (const [, value] of this.store.entries({
      ...options,
      lower: [this.entityId, this.attr, index],
      upper: [this.entityId, this.attr, index],
      upperOpen: false,
      limit: 1,
    })) {
      return value;
    }
  }

  public async has(index: string, options?: AbortOptions): Promise<boolean> {
    return (await this.get(index, options)) !== void 0;
  }

  public async * getMany(indices: Iterable<string>, options?: AbortOptions): AsyncIterableIterator<V | undefined> {
    const entityKeys: EntityAttrSearchKey<Id>[] = [];
    for (const index of indices) {
      entityKeys.push([this.entityId, this.attr, index]);
    }

    for await (const iter of this.store.findMany(entityKeys, options)) {
      const result = await iter.next();
      yield result.done ? void 0 : result.value[1];
    }
  }

  public async * hasMany(indices: Iterable<string>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    for await (const value of this.getMany(indices, options)) {
      yield value !== void 0;
    }
  }

  public async * entries(options?: RangeQueryOptions<string>): AsyncIterableIterator<[string, V]> {
    const lower: EntityAttrSearchKey<Id> = [this.entityId, this.attr, options?.lower];
    let upper: EntityAttrSearchKey<Id> = [this.entityId, this.attr];
    let upperOpen = false;
    if (options?.upper !== void 0) {
      upper = [this.entityId, this.attr, options.upper];
      upperOpen = options.upperOpen ?? true;
    }

    for await (const [[_id, _attr, index], value] of this.store.entries({ ...options, lower, upper, upperOpen })) {
      yield [index, value];
    }
  }

  public async * keys(options?: RangeQueryOptions<string>): AsyncIterableIterator<string> {
    for await (const [key] of this.entries(options)) { yield key; }
  }

  public async * values(options?: RangeQueryOptions<string>): AsyncIterableIterator<V> {
    for await (const [, value] of this.entries(options)) { yield value; }
  }

  public [Symbol.asyncIterator](): AsyncIterator<V> {
    return this.values();
  }

  public get [rangeQueryable](): true {
    return true;
  }

  public get [Symbol.toStringTag](): string {
    return ReadonlyLSeq.name;
  }
}
