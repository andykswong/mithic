import { SyncOrAsyncIterable } from '@mithic/commons';
import { AggregateCommandHandler, AggregateProjection, AggregateQuery, AggregateQueryResolver } from '../aggregate.js';
import { StandardCommand, StandardEvent } from '../action.js';
import { MapEventPayload, MapRangeQueryOptions } from '../map/index.js';
import { EntityStore, ReadonlyEntityStore } from '../store/index.js';

/** {@link AggregateCommandHandler} for List CRDT. */
export type ListCommandHandler<K, V> =
  AggregateCommandHandler<ReadonlyEntityStore<K, V>, ListCommand<K, V>, ListEvent<K, V>>;

/** {@link AggregateProjection} for List CRDT. */
export type ListProjection<K, V> =
  AggregateProjection<EntityStore<K, V>, ListEvent<K, V>>;

/** {@link AggregateQueryResolver} for List CRDT. */
export type ListRangeQueryResolver<K, V> =
  AggregateQueryResolver<ReadonlyEntityStore<K, V>, ListRangeQuery<K, V>>;

/** Command type for List CRDT. */
export enum ListCommandType {
  /** Sets or deletes set fields. */
  Update = 'LIST_OPS',
}

/** Command for List CRDT. */
export type ListCommand<K, V> = StandardCommand<ListCommandType, ListCommandPayload<V>, K>;

/** Command payload for List CRDT. */
export interface ListCommandPayload<V> {
  /** The index at which insertion or deletion should occur. Defaults to the end of list (append). */
  readonly index?: string;

  /** Inserts given sequence of values before specified index. */
  readonly add?: readonly V[];

  /** Deletes given number of indices at or after specified index. */
  readonly del?: number;
}

/** Event for List CRDT. */
export type ListEvent<K, V> = StandardEvent<ListEventType, MapEventPayload<V>, K>;

/** Event type for List CRDT. */
export enum ListEventType {
  /** Creates a new List. */
  New = 'LIST_NEW',

  /** Inserts or deletes values in the List. */
  Update = 'LIST_OPS',
}

/** Query payload for List CRDT.  */
export interface ListRangeQuery<K, V>
  extends AggregateQuery<SyncOrAsyncIterable<[index: string, value: V]>>, MapRangeQueryOptions<K> { }
