import {
  MaybeAsyncMapBatch, MaybeAsyncReadonlyMapBatch, RangeQueryOptions, RangeQueryable
} from '@mithic/collections';
import { AbortOptions, MaybeAsyncIterableIterator } from '@mithic/commons';

/** Entity triplestore. */
export interface EntityStore<Id, V>
  extends ReadonlyEntityStore<Id, V>, MaybeAsyncMapBatch<EntityAttrKey<Id>, V> {
}

/** Readonly {@link EntityStore}. */
export interface ReadonlyEntityStore<Id, V>
  extends MaybeAsyncReadonlyMapBatch<EntityAttrKey<Id>, V>, RangeQueryable<EntityAttrKey<Id>, V> {

  /** Checks if given list of transaction Ids is known. */
  isKnown(txIds: Iterable<Id>, options?: AbortOptions): MaybeAsyncIterableIterator<boolean>;

  /** Queries entries by attribute value. */
  entriesByAttr(
    options?: RangeQueryOptions<AttrValueKey<Id, V>>
  ): MaybeAsyncIterableIterator<[EntityAttrKey<Id>, V]>;

  /** Queries {@link EntityAttrKey} by attribute value. */
  keysByAttr(
    options?: RangeQueryOptions<AttrValueKey<Id, V>>
  ): MaybeAsyncIterableIterator<EntityAttrKey<Id>>;
}

/** {@link EntityStore} entry primary key. */
export type EntityAttrKey<Id> = readonly [entityId: Id, attr: string, txId?: Id];

/** {@link EntityStore} entry index key. */
export type AttrValueKey<Id, V> = readonly [attr: string, value?: V, txId?: Id];
