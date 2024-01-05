import {
  MaybeAsyncReadonlyMap, MaybeAsyncReadonlyMapBatch, RangeQueryOptions, RangeQueryable
} from '@mithic/collections';
import { AbortOptions, MaybeAsyncIterableIterator, MaybePromise } from '@mithic/commons';

/** Readonly entity view collection. */
export interface ReadonlyEntityCollection<Id, V>
  extends MaybeAsyncReadonlyMap<Id, EntityView<V>>, MaybeAsyncReadonlyMapBatch<Id, EntityView<V>>,
  RangeQueryable<Id, EntityView<V>> {

  get<L extends EntityAttrLookup<V>>(
    id: Id, options?: EntityViewOptions<V, L>
  ): MaybePromise<EntityView<V, L> | undefined>;

  getMany<L extends EntityAttrLookup<V>>(
    ids: Iterable<Id>, options?: EntityViewOptions<V, L>
  ): MaybeAsyncIterableIterator<EntityView<V, L> | undefined>;

  has(id: Id, options?: EntityTypeOptions): MaybePromise<boolean>;

  hasMany(ids: Iterable<Id>, options?: EntityTypeOptions): MaybeAsyncIterableIterator<boolean>;

  entries<L extends EntityAttrLookup<V>>(
    options?: EntityRangeQueryOptions<Id, V, L>
  ): MaybeAsyncIterableIterator<[Id, EntityView<V, L>]>;

  keys<L extends EntityAttrLookup<V>>(options?: EntityRangeQueryOptions<Id, V, L>): MaybeAsyncIterableIterator<Id>;

  values<L extends EntityAttrLookup<V>>(
    options?: EntityRangeQueryOptions<Id, V, L>
  ): MaybeAsyncIterableIterator<EntityView<V, L>>;

  entriesByAttr<L extends EntityAttrLookup<V>>(
    options?: EntityAttrRangeQueryOptions<V, L>
  ): MaybeAsyncIterableIterator<[Id, EntityView<V, L>]>;

  keysByAttr<L extends EntityAttrLookup<V>>(
    options?: EntityAttrRangeQueryOptions<V, L>
  ): MaybeAsyncIterableIterator<Id>;

  valuesByAttr<L extends EntityAttrLookup<V>>(
    options?: EntityAttrRangeQueryOptions<V, L>
  ): MaybeAsyncIterableIterator<EntityView<V, L>>;
}

/** Entity view options for {@link ReadonlyEntityCollection}. */
export interface EntityViewOptions<V, L extends EntityAttrLookup<V> = EntityAttrLookup<V>> extends EntityTypeOptions {
  /** Attributes to retrieve. Defaults to retrieve all attributes. */
  readonly attr?: L;
}

/** Entity range query options for a {@link ReadonlyEntityCollection}. */
export interface EntityRangeQueryOptions<K, V, L extends EntityAttrLookup<V> = EntityAttrLookup<V>>
  extends RangeQueryOptions<K>, EntityViewOptions<V, L> { }

/** Entity attribute range query options for a {@link ReadonlyEntityCollection}. */
export interface EntityAttrRangeQueryOptions<V, L extends EntityAttrLookup<V> = EntityAttrLookup<V>>
  extends EntityRangeQueryOptions<V, V, L> {
  /** Attribute to query by. Defaults to $id. */
  readonly by?: string;
}

/** Entity type options for {@link ReadonlyEntityCollection}. */
export interface EntityTypeOptions extends AbortOptions {
  /** Entity type to use. */
  readonly type?: string;
}

/** Entity attribute lookup. */
export type EntityAttrLookup<V> = {
  readonly [key: string]: EntityAttrReducer<V> | true | undefined;
};

/** Entity view for {@link ReadonlyEntityCollection}. */
export type EntityView<V, L extends EntityAttrLookup<V> = EntityAttrLookup<V>> = {
  readonly [K in keyof L & string]: (L[K] extends EntityAttrReducer<V, infer T> ? T : V) | undefined;
};

/** Reduce function for an entity attribute lookup. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface EntityAttrReducer<V, T = any> {
  (result: T | undefined, value: V, attr: string, tag: string): T;
}
