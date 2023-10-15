import {
  AppendOnlyAutoKeyMap, AutoKeyMapPutBatch, MaybeAsyncReadonlyMapBatch, ReadonlyAutoKeyMap
} from '@mithic/collections';
import {
  AbortOptions, ContentId, MaybeAsyncIterableIterator, MaybePromise, SyncOrAsyncGenerator
} from '@mithic/commons';

/** An append-only event store. */
export interface EventStore<K = ContentId, V = unknown, QueryExt extends object = NonNullable<unknown>>
  extends ReadonlyEventStore<K, V, QueryExt>, AppendOnlyAutoKeyMap<K, V>, AutoKeyMapPutBatch<K, V>
{
  put(value: V, options?: EventStorePutOptions): MaybePromise<K>;

  putMany(values: Iterable<V>, options?: EventStorePutOptions): MaybeAsyncIterableIterator<[key: K, error?: Error]>;
}

/** A read-only event store. */
export interface ReadonlyEventStore<K = ContentId, V = unknown, QueryExt extends object = NonNullable<unknown>>
  extends ReadonlyAutoKeyMap<K, V>, MaybeAsyncReadonlyMapBatch<K, V>, EventStoreQuery<K, V, QueryExt> {

  /** Validates given event and returns any error. */
  validate(value: V, options?: AbortOptions): MaybePromise<Error | undefined>;
}

/** Query APIs for an event store. */
export interface EventStoreQuery<K = ContentId, V = unknown, QueryExt extends object = NonNullable<unknown>> {
  /** Queries entries by given criteria. */
  entries(options?: EventStoreQueryOptions<K> & QueryExt): SyncOrAsyncGenerator<[K, V], K[]>;

  /** Queries event keys by given criteria. */
  keys(options?: EventStoreQueryOptions<K> & QueryExt): SyncOrAsyncGenerator<K, K[]>;

  /** Queries events by given criteria. */
  values(options?: EventStoreQueryOptions<K> & QueryExt): SyncOrAsyncGenerator<V, K[]>;
}

/** Standard options for a {@link EventStoreQuery} query. */
export interface EventStoreQueryOptions<K> extends AbortOptions {
  /** Events after which result shall be returned. */
  since?: K[];

  /** True to return only head events. */
  head?: boolean;

  /** Maximum number of events to return. */
  limit?: number;
}

/** Extended options for filtering {@link EventStoreQuery} query results by metadata. */
export interface EventStoreMetaQueryOptions<K> {
  /** Event type prefixes to query. */
  type?: string;

  /** Aggregate root to query. */
  root?: K;
}

/** Options for putting event into {@link EventStore} */
export interface EventStorePutOptions extends AbortOptions {
  /** Whether to validate input. Defaults to true. */
  readonly validate?: boolean;
}
