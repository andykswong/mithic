import {
  EntityAttrSearchKey, MaybeAsyncReadonlySet, MaybeAsyncReadonlySetBatch, RangeQueryOptions, RangeQueryable,
  ReadonlyTripleStore, rangeQueryable
} from '@mithic/collections';
import { AbortOptions, ContentId, MaybePromise } from '@mithic/commons';
import { defaultStringify } from '../defaults.ts';

/** Readonly observed-removed map. */
export class ReadonlyORSet<V = unknown, Id = ContentId>
  implements MaybeAsyncReadonlySet<V>, MaybeAsyncReadonlySetBatch<V>, RangeQueryable<V, V>, AsyncIterable<V>
{
  public constructor(
    /** The underlying store. */
    protected readonly store: ReadonlyTripleStore<Id, V>,
    /** The set entity ID. */
    public readonly entityId: Id,
    /** Attribute name that holds this set. */
    public readonly attr: string,
    /** Function for converting value to hash string. */
    protected readonly stringify: (value: V, options?: AbortOptions) => MaybePromise<string> = defaultStringify,
  ) { }

  public async has(value: V, options?: AbortOptions): Promise<boolean> {
    const key = await this.stringify(value, options);
    for await (const _ of this.store.entries({
      ...options,
      lower: [this.entityId, this.attr, key],
      upper: [this.entityId, this.attr, key],
      upperOpen: false,
      limit: 1,
    })) {
      return true;
    }
    return false;
  }

  public async * hasMany(keys: Iterable<V>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    const entityKeys: EntityAttrSearchKey<Id>[] = [];
    for (const key of keys) {
      entityKeys.push([this.entityId, this.attr, await this.stringify(key, options)]);
    }

    for await (const iter of this.store.findMany(entityKeys, options)) {
      yield !(await iter.next()).done;
    }
  }

  public async * keys(options?: RangeQueryOptions<V>): AsyncIterableIterator<V> {
    const lower: EntityAttrSearchKey<Id> = [
      this.entityId, this.attr, options?.lower !== void 0 ? await this.stringify(options?.lower, options) : ''
    ];
    let upper: EntityAttrSearchKey<Id> = [this.entityId, this.attr];
    let upperOpen = false;
    if (options?.upper !== void 0) {
      upper = [this.entityId, this.attr, await this.stringify(options.upper, options)];
      upperOpen = options.upperOpen ?? true;
    }

    for await (const [, value] of this.store.entries({ ...options, lower, upper, upperOpen })) {
      yield value;
    }
  }

  public values(options?: RangeQueryOptions<V>): AsyncIterableIterator<V> {
    return this.keys(options);
  }

  public async * entries(options?: RangeQueryOptions<V>): AsyncIterableIterator<[V, V]> {
    for await (const key of this.keys(options)) { yield [key, key]; }
  }

  public [Symbol.asyncIterator](): AsyncIterator<V> {
    return this.values();
  }

  public get [rangeQueryable](): true {
    return true;
  }

  public get [Symbol.toStringTag](): string {
    return ReadonlyORSet.name;
  }
}
