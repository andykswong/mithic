import {
  AppendOnlyAutoKeyMap, AutoKeyMapPutBatch, MaybeAsyncReadonlyMapBatch, MaybeAsyncReadonlyMap
} from '@mithic/collections';
import { AbortOptions, ContentId, SyncOrAsyncGenerator } from '@mithic/commons';
import { Event } from './event.js';

/** An append-only event log graph store. */
export interface EventStore<K = ContentId, V = Event, QueryExt = Record<string, never>>
  extends ReadonlyEventStore<K, V, QueryExt>, AppendOnlyAutoKeyMap<K, V>, AutoKeyMapPutBatch<K, V> {
}

/** A read-only event log graph store. */
export interface ReadonlyEventStore<K = ContentId, V = Event, QueryExt = Record<string, never>>
  extends MaybeAsyncReadonlyMap<K, V>, MaybeAsyncReadonlyMapBatch<K, V> {

  /** Queries entries by given criteria. */
  entries(options?: EventStoreQueryOptions<K> & QueryExt): SyncOrAsyncGenerator<[K, V], K[]>;

  /** Queries event keys by given criteria. */
  keys(options?: EventStoreQueryOptions<K> & QueryExt): SyncOrAsyncGenerator<K, K[]>;

  /** Queries events by given criteria. */
  values(options?: EventStoreQueryOptions<K> & QueryExt): SyncOrAsyncGenerator<V, K[]>;
}

/** Options for a {@link ReadonlyEventStore} query. */
export interface EventStoreQueryOptions<K> extends AbortOptions {
  /** Events after which result shall be returned. */
  since?: K[];

  /** True to return only head events. */
  head?: boolean;

  /** Maximum number of events to return. */
  limit?: number;
}

/** Extended options for filtering event results by attributes. */
export interface EventStoreQueryOptionsExt<K> {
  /** Event type prefixes to query. */
  type?: string;

  /** Aggregate root to query. */
  root?: K;
}
