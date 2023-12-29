import {
  MaybeAsyncMapBatch, MaybeAsyncReadonlyMapBatch, RangeQueryOptions, RangeQueryable
} from '@mithic/collections';
import { AbortOptions, MaybeAsyncIterableIterator } from '@mithic/commons';

/** Entity triplestore. */
export interface EntityStore<K, V>
  extends ReadonlyEntityStore<K, V>, MaybeAsyncMapBatch<EntityFieldKey<K>, V> {
}

/** Readonly {@link EntityStore}. */
export interface ReadonlyEntityStore<K, V>
  extends MaybeAsyncReadonlyMapBatch<EntityFieldKey<K>, V>, RangeQueryable<EntityFieldKey<K>, V> {

  /** Checks if given list of entry Ids has been processed. */
  hasEntries(ids: Iterable<K>, options?: AbortOptions): MaybeAsyncIterableIterator<boolean>;

  /** Queries entities by field value. May return duplicate entities if concurrent field values exist. */
  entities(options?: RangeQueryOptions<FieldValueKey<K, V>>): MaybeAsyncIterableIterator<K>;
}

/** {@link EntityStore} entry primary key. */
export type EntityFieldKey<K> = readonly [entityId: K, field: string, entryId?: K];

/** {@link EntityStore} entry index key. */
export type FieldValueKey<K, V> = readonly [field: string, value?: V, entryId?: K];
