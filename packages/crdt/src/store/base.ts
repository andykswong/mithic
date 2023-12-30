import { RangeQueryOptions, rangeQueryable } from '@mithic/collections';
import { AbortOptions, MaybeAsyncIterableIterator } from '@mithic/commons';
import { EntityAttrKey, EntityStore, AttrValueKey } from './store.js';

/** Abstract {@link EntityStore} base class. */
export abstract class BaseEntityStore<K, V> implements EntityStore<K, V>, AsyncIterable<[EntityAttrKey<K>, V]> {
  public abstract getMany(
    keys: Iterable<EntityAttrKey<K>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<V | undefined>;

  public abstract entriesByAttr(
    options?: RangeQueryOptions<AttrValueKey<K, V>>
  ): MaybeAsyncIterableIterator<[EntityAttrKey<K>, V]>;

  public abstract entries(
    options?: RangeQueryOptions<EntityAttrKey<K>>
  ): MaybeAsyncIterableIterator<[EntityAttrKey<K>, V]>;

  public abstract isKnown(ids: Iterable<K>, options?: AbortOptions): MaybeAsyncIterableIterator<boolean>;

  public abstract updateMany(
    entries: Iterable<readonly [key: EntityAttrKey<K>, value?: V]>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<Error | undefined>;

  public async * hasMany(
    keys: Iterable<EntityAttrKey<K>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<boolean> {
    for await (const value of this.getMany(keys, options)) {
      yield value !== void 0;
    }
  }

  public deleteMany(
    keys: Iterable<EntityAttrKey<K>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<Error | undefined> {
    return this.updateMany([...keys].map((key) => [key]), options);
  }

  public setMany(
    entries: Iterable<readonly [EntityAttrKey<K>, V]>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<Error | undefined> {
    return this.updateMany(entries, options);
  }

  public async * keys(options?: RangeQueryOptions<EntityAttrKey<K>>): MaybeAsyncIterableIterator<EntityAttrKey<K>> {
    for await (const [key] of this.entries(options)) { yield key; }
  }

  public async * values(options?: RangeQueryOptions<EntityAttrKey<K>>): MaybeAsyncIterableIterator<V> {
    for await (const [, value] of this.entries(options)) { yield value; }
  }

  public async * keysByAttr(
    options?: RangeQueryOptions<AttrValueKey<K, V>>
  ): MaybeAsyncIterableIterator<EntityAttrKey<K>> {
    for await (const [key] of this.entriesByAttr(options)) { yield key; }
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<[EntityAttrKey<K>, V]> {
    yield* this.entries();
  }

  public get [rangeQueryable](): true {
    return true;
  }

  public get [Symbol.toStringTag](): string {
    return 'EntityStore';
  }
}
