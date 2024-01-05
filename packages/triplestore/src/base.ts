import { RangeQueryOptions, rangeQueryable } from '@mithic/collections';
import { MaybeAsyncIterableIterator, AbortOptions } from '@mithic/commons';
import { AttrSearchKey, EntityAttrKey, EntityAttrSearchKey, TripleStore } from './store.js';

/** {@link TripleStore} base class. */
export abstract class BaseTripleStore<Id, V> implements TripleStore<Id, V>, AsyncIterable<[EntityAttrKey<Id>, V]> {
  public abstract entries(
    options?: RangeQueryOptions<EntityAttrSearchKey<Id>>
  ): MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>;

  public abstract entriesByAttr(
    options?: RangeQueryOptions<AttrSearchKey>
  ): MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>;

  public abstract findMany(
    keys: Iterable<EntityAttrSearchKey<Id>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>>;

  public abstract findManyByAttr(
    keys: Iterable<AttrSearchKey>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>>;

  public abstract getMany(
    keys: Iterable<EntityAttrKey<Id>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<V | undefined>;

  public abstract updateMany(
    entries: Iterable<readonly [key: EntityAttrKey<Id>, value?: V]>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<Error | undefined>;

  public async * keys(options?: RangeQueryOptions<EntityAttrSearchKey<Id>>): AsyncIterableIterator<EntityAttrKey<Id>> {
    for await (const [key] of this.entries(options)) { yield key; }
  }

  public async * values(options?: RangeQueryOptions<EntityAttrSearchKey<Id>>): AsyncIterableIterator<V> {
    for await (const [, value] of this.entries(options)) { yield value; }
  }

  public async * keysByAttr(options?: RangeQueryOptions<AttrSearchKey>): AsyncIterableIterator<EntityAttrKey<Id>> {
    for await (const [key] of this.entriesByAttr(options)) { yield key; }
  }

  public async * valuesByAttr(options?: RangeQueryOptions<AttrSearchKey>): AsyncIterableIterator<V> {
    for await (const [, value] of this.entriesByAttr(options)) { yield value; }
  }

  public async get(key: EntityAttrKey<Id>, options?: AbortOptions): Promise<V | undefined> {
    for await (const value of this.getMany([key], options)) { return value; }
  }

  public async has(key: EntityAttrKey<Id>, options?: AbortOptions): Promise<boolean> {
    for await (const value of this.getMany([key], options)) { return value !== void 0; }
    return false;
  }

  public async delete(key: EntityAttrKey<Id>, options?: AbortOptions): Promise<void> {
    for await (const error of this.updateMany([[key]], options)) {
      if (error) { throw error; }
    }
  }

  public async set(key: EntityAttrKey<Id>, value: V, options?: AbortOptions): Promise<void> {
    for await (const error of this.updateMany([[key, value]], options)) {
      if (error) { throw error; }
    }
  }

  public async * hasMany(keys: Iterable<EntityAttrKey<Id>>, options?: AbortOptions): AsyncIterableIterator<boolean> {
    for await (const value of this.getMany(keys, options)) { yield value !== void 0; }
  }

  public setMany(
    entries: Iterable<readonly [EntityAttrKey<Id>, V]>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<Error | undefined> {
    return this.updateMany(entries, options);
  }

  public deleteMany(
    keys: Iterable<EntityAttrKey<Id>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<Error | undefined> {
    return this.updateMany([...keys].map(key => [key]), options);
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<[EntityAttrKey<Id>, V]> {
    yield* this.entries();
  }

  public get [rangeQueryable](): true {
    return true;
  }

  public get [Symbol.toStringTag](): string {
    return 'TripleStore';
  }
}
