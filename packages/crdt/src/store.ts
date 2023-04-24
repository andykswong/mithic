import { AppendOnlyAutoKeyMap, AutoKeyMapBatch, MaybeAsyncReadonlyMap } from '@mithic/collections';
import { AbortOptions, CodedError, ContentId, MaybeAsyncIterableIterator } from '@mithic/commons';
import { Event } from './event.js';

/** An append-only event log graph store. */
export interface EventStore<K = ContentId, V = Event, QueryExt = Record<string, never>>
  extends ReadonlyEventStore<K, V, QueryExt>, AppendOnlyAutoKeyMap<K, V>, Omit<AutoKeyMapBatch<K, V>, 'deleteMany'> {

  /** Merges given events into this store and returns the results. */
  merge(
    values: MaybeAsyncIterableIterator<V>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<EventMergeResult<K>>;
}

/** A read-only event log graph store. */
export interface ReadonlyEventStore<K = ContentId, V = Event, QueryExt = Record<string, never>>
  extends MaybeAsyncReadonlyMap<K, V>, Pick<AutoKeyMapBatch<K, V>, 'getMany'> {

  /** Queries entries by given criteria. */
  entries(options?: EventStoreQueryOptions<K> & QueryExt): MaybeAsyncIterableIterator<[K, V]>;

  /** Queries event keys by given criteria. */
  keys(options?: EventStoreQueryOptions<K> & QueryExt): MaybeAsyncIterableIterator<K>;
}

/** Result of merging an event from {@link EventStore}. */
export interface EventMergeResult<K> {
  /** Event key. */
  key: K;

  /** If defined, this specifies that the key failed to merge and provides the error code. */
  error?: CodedError;

  /** If defined, this specifies the missing dependent (parent) events that causes the key to fail to merge. */
  missing?: K[];
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

/** Extended options for querying event store by metadata. */
export interface EventStoreQueryOptionsExt<K> {
  /** Aggregate roots to query. */
  root?: K[];

  /** Timestamp after which events will be returned. */
  after?: number;
}
