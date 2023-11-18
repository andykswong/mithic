import { SyncOrAsyncIterable } from '@mithic/commons';
import { AggregateCommandHandler, AggregateProjection, AggregateQuery, AggregateQueryResolver } from '../aggregate.js';
import { StandardCommand, StandardEvent } from '../action.js';
import { MapRangeQueryOptions, MapStore, ReadonlyMapStore } from '../map/index.js';

/** {@link AggregateCommandHandler} for a CRDT multiset. */
export type SetCommandHandler<K, V> =
  AggregateCommandHandler<ReadonlyMapStore<K, V>, SetCommand<K, V>, SetEvent<K, V>>;

/** {@link AggregateProjection} for a CRDT multiset. */
export type SetProjection<K, V> =
  AggregateProjection<MapStore<K, V>, SetEvent<K, V>>;

/** {@link AggregateQueryResolver} for a CRDT multiset range query. */
export type SetRangeQueryResolver<K, V> =
  AggregateQueryResolver<ReadonlyMapStore<K, V>, SetRangeQuery<K, V>>;

/** Command type for a CRDT multiset. */
export enum SetCommandType {
  /** Sets or deletes set fields. */
  Update = 'SET_OPS',
}

/** Command for a CRDT multiset. */
export type SetCommand<K, V> = StandardCommand<SetCommandType, SetCommandPayload<V>, K>;

/** Command payload for a CRDT multiset. */
export interface SetCommandPayload<V> {
  /** Adds given values to the set. */
  readonly add?: readonly V[];

  /** Deletes all copies of given values from the set. */
  readonly del?: readonly V[];
}

/** Event type for a CRDT multiset. */
export enum SetEventType {
  /** Creates a new set. */
  New = 'SET_NEW',

  /** Adds or deletes values in the set. */
  Update = 'SET_OPS',
}

/** Event for a CRDT multiset. */
export type SetEvent<K, V> = StandardEvent<SetEventType, SetEventPayload<V>, K>;

/** Event payload for a CRDT multiset. */
export interface SetEventPayload<V> {
  /** Operations to add or delete given values in the set. */
  readonly set: SetEventOp<V>[];
}

/** Operation in a CRDT multiset event. */
export type SetEventOp<V> = readonly [value: V, isAdd: boolean, ...parentIdxToDelete: number[]];

/** Query options for a CRDT multiset.  */
export interface SetRangeQuery<K, V> extends AggregateQuery<SyncOrAsyncIterable<V>>, MapRangeQueryOptions<K, V> { }
