import { RangeQueryOptions, rangeQueryable } from '@mithic/collections';
import { AbortOptions, MaybeAsyncIterableIterator } from '@mithic/commons';
import { EntityFieldKey, EntityStore, FieldValueKey } from './store.js';

/** Abstract {@link EntityStore} base class. */
export abstract class BaseEntityStore<K, V> implements EntityStore<K, V>, AsyncIterable<[EntityFieldKey<K>, V]> {
  public abstract getMany(
    keys: Iterable<EntityFieldKey<K>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<V | undefined>;

  public abstract entities(options?: RangeQueryOptions<FieldValueKey<K, V>>): MaybeAsyncIterableIterator<K>;

  public abstract entries(
    options?: RangeQueryOptions<EntityFieldKey<K>>
  ): MaybeAsyncIterableIterator<[EntityFieldKey<K>, V]>;

  public abstract hasEntries(ids: Iterable<K>, options?: AbortOptions): MaybeAsyncIterableIterator<boolean>;

  public abstract updateMany(
    entries: Iterable<readonly [key: EntityFieldKey<K>, value?: V]>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<Error | undefined>;

  public async * hasMany(
    keys: Iterable<EntityFieldKey<K>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<boolean> {
    for await (const value of this.getMany(keys, options)) {
      yield value !== void 0;
    }
  }

  public deleteMany(
    keys: Iterable<EntityFieldKey<K>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<Error | undefined> {
    return this.updateMany([...keys].map((key) => [key]), options);
  }

  public setMany(
    entries: Iterable<readonly [EntityFieldKey<K>, V]>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<Error | undefined> {
    return this.updateMany(entries, options);
  }

  public async * keys(options?: RangeQueryOptions<EntityFieldKey<K>>): MaybeAsyncIterableIterator<EntityFieldKey<K>> {
    for await (const [key] of this.entries(options)) {
      yield key;
    }
  }

  public async * values(options?: RangeQueryOptions<EntityFieldKey<K>>): MaybeAsyncIterableIterator<V> {
    for await (const [, value] of this.entries(options)) {
      yield value;
    }
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<[EntityFieldKey<K>, V]> {
    yield* this.entries();
  }

  public get [rangeQueryable](): true {
    return true;
  }

  public get [Symbol.toStringTag](): string {
    return 'EntityStore';
  }
}
