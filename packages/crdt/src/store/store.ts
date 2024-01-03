import { MaybeAsyncMapGetBatch, MaybeAsyncMapUpdateBatch, RangeQueryOptions } from '@mithic/collections';
import { AbortOptions, MaybeAsyncIterableIterator, MaybePromise } from '@mithic/commons';

/** Provider of {@link EntityStore} of given type. */
export interface EntityStoreProvider<Id, V> extends ReadonlyEntityStoreProvider<Id, V> {
  (type?: string): MaybePromise<EntityStore<Id, V>>;
}

/** Provider of {@link ReadonlyEntityStore} of given type. */
export interface ReadonlyEntityStoreProvider<Id, V> {
  (type?: string): MaybePromise<ReadonlyEntityStore<Id, V>>;
}

/** Entity-attribute-value triplestore with transaction ID tags for conflict resolution. */
export interface EntityStore<Id, V>
  extends ReadonlyEntityStore<Id, V>, MaybeAsyncMapUpdateBatch<EntityAttrKey<Id>, V> {

  updateMany(
    entries: Iterable<readonly [key: EntityAttrKey<Id>, value?: V]>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<Error | undefined>;
}

/** Readonly {@link EntityStore}. */
export interface ReadonlyEntityStore<Id, V> extends MaybeAsyncMapGetBatch<EntityAttrKey<Id>, V> {
  /** Iterates entries by given entity-attribute key range. */
  entries(
    options?: RangeQueryOptions<EntityAttrSearchKey<Id>>
  ): MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>;

  /** Iterates entries by given attribute-value key range. */
  entriesByAttr(
    options?: RangeQueryOptions<AttrValueSearchKey<V>>
  ): MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>;

  /** Finds matching entries for given list of entity-attribute search keys. */
  findMany(
    keys: Iterable<EntityAttrSearchKey<Id>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>>;

  /** Finds matching entries for given list of attribute-value search keys. */
  findManyByAttr(
    keys: Iterable<AttrValueSearchKey<V>>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>>;

  /** Checks if given list of transaction Ids has been processed by this store. */
  hasTx(txIds: Iterable<Id>, options?: AbortOptions): MaybeAsyncIterableIterator<boolean>;
}

/** {@link EntityStore} entry primary key. */
export type EntityAttrKey<Id> = readonly [entityId: Id, attr: string, txId?: Id];

/** {@link EntityStore} entry partial primary key for search. */
export type EntityAttrSearchKey<Id> = readonly [entityId: Id, attr?: string];

/** {@link EntityStore} entry attribute index search key. */
export type AttrValueSearchKey<V> = readonly [attr: string, value?: V];
