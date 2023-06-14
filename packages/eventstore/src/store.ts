import {
  AppendOnlyAutoKeyMap, AutoKeyMapPutBatch, MaybeAsyncReadonlyMapBatch, ReadonlyAutoKeyMap
} from '@mithic/collections';
import { AbortOptions, CodedError, ContentId, MaybePromise, SyncOrAsyncGenerator } from '@mithic/commons';
import { Event } from './event.js';

/** An append-only event store. */
// eslint-disable-next-line @typescript-eslint/ban-types
export interface EventStore<K = ContentId, V = Event, QueryExt extends object = {}>
  extends ReadonlyEventStore<K, V, QueryExt>, AppendOnlyAutoKeyMap<K, V>, AutoKeyMapPutBatch<K, V> {
}

/** A read-only event store. */
// eslint-disable-next-line @typescript-eslint/ban-types
export interface ReadonlyEventStore<K = ContentId, V = Event, QueryExt extends object = {}>
  extends ReadonlyAutoKeyMap<K, V>, MaybeAsyncReadonlyMapBatch<K, V>, EventStoreQuery<K, V, QueryExt> {

  /** Validates given event and returns any error. */
  validate(value: V, options?: AbortOptions): MaybePromise<CodedError<K[]> | undefined>;
}

/** Query APIs for an event store. */
// eslint-disable-next-line @typescript-eslint/ban-types
export interface EventStoreQuery<K = ContentId, V = Event, QueryExt extends object = {}> {
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
