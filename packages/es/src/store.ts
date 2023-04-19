import { AppendOnlyContentAddressedStore, MaybeAsyncReadonlyMap } from '@mithic/collections';
import { AbortOptions, CodedError, MaybeAsyncIterableIterator, MaybePromise } from '@mithic/commons';
import { Timestamp } from './clock.js';

/** An append-only event store. */
export interface EventStore<K, V, C = Timestamp>
  extends ReadonlyEventStore<K, V, C>, AppendOnlyContentAddressedStore<K, V> {

  /** Merges given events into this store and returns the results. */
  merge(
    entries: MaybeAsyncIterableIterator<[K, V]>, options?: AbortOptions
  ): MaybeAsyncIterableIterator<EventMergeResult<K>>;
}

/** A read-only event store. */
export interface ReadonlyEventStore<K, V, C = Timestamp> extends MaybeAsyncReadonlyMap<K, V> {
  /** Returns the latest checkpoint token. */
  checkpoint(options?: AbortOptions): MaybePromise<C>;

  /** Queries entries by given criteria. */
  entries(options?: EventStoreQueryOptions<C>): MaybeAsyncIterableIterator<[K, V]>;

  /** Queries event keys by given criteria. */
  keys(options?: EventStoreQueryOptions<C>): MaybeAsyncIterableIterator<K>;
}

/** Result of merging an event from {@link EventStore}. */
export interface EventMergeResult<K> {
  /** Event key. */
  key: K;

  /** Error with code, if failed to merge. */
  err?: CodedError;
}

/** Options for a {@link ReadonlyEventStore} query. */
export interface EventStoreQueryOptions<C> extends AbortOptions {
  /** Checkpoint token, after which events will be returned. */
  checkpoint?: C;
}
