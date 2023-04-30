import { AppendOnlyAutoKeyMap, AutoKeyMapPutBatch, MaybeAsyncMapGetBatch, MaybeAsyncReadonlyMap } from '@mithic/collections';
import { AbortOptions, ContentId, MaybeAsyncIterableIterator } from '@mithic/commons';
import { Event } from './event.js';

/** An append-only event log graph store. */
export interface EventStore<K = ContentId, V = Event, QueryExt = Record<string, never>>
  extends ReadonlyEventStore<K, V, QueryExt>, AppendOnlyAutoKeyMap<K, V>, AutoKeyMapPutBatch<K, V> {
}

/** A read-only event log graph store. */
export interface ReadonlyEventStore<K = ContentId, V = Event, QueryExt = Record<string, never>>
  extends MaybeAsyncReadonlyMap<K, V>, MaybeAsyncMapGetBatch<K, V> {

  /** Queries entries by given criteria. */
  entries(options?: EventStoreQueryOptions<K> & QueryExt): MaybeAsyncIterableIterator<[K, V]>;

  /** Queries event keys by given criteria. */
  keys(options?: EventStoreQueryOptions<K> & QueryExt): MaybeAsyncIterableIterator<K>;
}

/** Options for a {@link ReadonlyEventStore} query. */
export interface EventStoreQueryOptions<K> extends AbortOptions {
  /** Checkpoint after which events shall be returned. */
  gt?: Iterable<K>;

  /** True to return only head events. */
  head?: boolean;

  /** Maximum number of events to return. */
  limit?: number;

  /** True to return events reversely iterated from heads. */
  reverse?: boolean;
}

/** Extended options for filtering event results by attributes. */
export interface EventStoreQueryOptionsExt<K> {
  /** Timestamp after which events will be returned. */
  afterEpoch?: number;

  /** Event type prefixes to query. */
  type?: string;

  /** Aggregate root to query. */
  root?: K;
}
