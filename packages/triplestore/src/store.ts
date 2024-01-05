import {
  MaybeAsyncMap, MaybeAsyncMapBatch, MaybeAsyncReadonlyMap, MaybeAsyncReadonlyMapBatch, RangeQueryOptions, RangeQueryable
} from '@mithic/collections';
import { AbortOptions, MaybeAsyncIterableIterator } from '@mithic/commons';

/** Tagged entity-attribute-value triplestore. */
export interface TripleStore<Id, V>
  extends ReadonlyTripleStore<Id, V>, MaybeAsyncMap<EntityAttrKey<Id>, V>, MaybeAsyncMapBatch<EntityAttrKey<Id>, V> { }

/** Readonly {@link TripleStore}. */
export interface ReadonlyTripleStore<Id, V>
  extends MaybeAsyncReadonlyMap<EntityAttrKey<Id>, V>, MaybeAsyncReadonlyMapBatch<EntityAttrKey<Id>, V>,
  RangeQueryable<EntityAttrSearchKey<Id>, V> {

  keys(options?: RangeQueryOptions<EntityAttrSearchKey<Id>>): MaybeAsyncIterableIterator<EntityAttrKey<Id>>;

  values(options?: RangeQueryOptions<EntityAttrSearchKey<Id>>): MaybeAsyncIterableIterator<V>;

  entries(options?: RangeQueryOptions<EntityAttrSearchKey<Id>>): MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>;

  /** Iterates keys by given attribute key range. */
  keysByAttr(options?: RangeQueryOptions<AttrSearchKey>): MaybeAsyncIterableIterator<EntityAttrKey<Id>>;

  /** Iterates values by given attribute key range. */
  valuesByAttr(options?: RangeQueryOptions<AttrSearchKey>): MaybeAsyncIterableIterator<V>;

  /** Iterates entries by given attribute key range. */
  entriesByAttr(options?: RangeQueryOptions<AttrSearchKey>): MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>;

  /** Finds matching entries for given list of entity-attribute search keys. */
  findMany(
    keys: Iterable<EntityAttrSearchKey<Id>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>>;

  /** Finds matching entries for given list of attribute-value search keys. */
  findManyByAttr(
    keys: Iterable<AttrSearchKey>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>>;
}

/** {@link TripleStore} tagged entity-attribute primary key. */
export type EntityAttrKey<Id = string> = readonly [entityId: Id, attr: string, tag: string, txId?: Id];

/** {@link TripleStore} partial primary key for search. */
export type EntityAttrSearchKey<Id = string> = readonly [entityId: Id, attr?: string, tag?: string, txId?: Id];

/** {@link TripleStore} tagged attribute search key. */
export type AttrSearchKey = readonly [attr: string, tag?: string];
