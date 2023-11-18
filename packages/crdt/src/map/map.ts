import { SyncOrAsyncIterable } from '@mithic/commons';
import { StandardCommand, StandardEvent } from '../action.js';
import { AggregateCommandHandler, AggregateProjection, AggregateQuery, AggregateQueryResolver } from '../aggregate.js';
import { MapStore, ReadonlyMapStore } from './store.js';

/** {@link AggregateCommandHandler} for a CRDT multimap. */
export type MapCommandHandler<K, V> =
  AggregateCommandHandler<ReadonlyMapStore<K, V>, MapCommand<K, V>, MapEvent<K, V>>;

/** {@link AggregateProjection} for a CRDT multimap. */
export type MapProjection<K, V> =
  AggregateProjection<MapStore<K, V>, MapEvent<K, V>>;

/** {@link AggregateQueryResolver} for a CRDT multimap range query. */
export type MapRangeQueryResolver<K, V> =
  AggregateQueryResolver<ReadonlyMapStore<K, V>, MapRangeQuery<K, V>>;

/** Command type for a CRDT multimap. */
export enum MapCommandType {
  /** Update map fields. */
  Update = 'MAP_OPS',
}

/** Command for a CRDT multimap. */
export type MapCommand<K, V> = StandardCommand<MapCommandType, MapCommandPayload<V>, K>;

/** Command payload for a CRDT multimap. */
export interface MapCommandPayload<V> {
  /** Operations to delete all existing values at given fields from the map. */
  readonly del?: readonly string[];

  /** Operations to put concurrent field values to the map. */
  readonly put?: Readonly<Record<string, V>>;
}

/** Event type for a CRDT multimap. */
export enum MapEventType {
  /** Creates a new map. */
  New = 'MAP_NEW',

  /** Sets or deletes map fields. */
  Update = 'MAP_OPS',
}

/** Event for a CRDT multimap. */
export type MapEvent<K, V> = StandardEvent<MapEventType, MapEventPayload<V>, K>;

/** Event payload for a CRDT multimap. */
export interface MapEventPayload<V> {
  /** Operations to set new value to given field, replacing existing values at given parent link indices. */
  readonly set: readonly MapEventOp<V>[];
}

/** Operation in a CRDT multimap event. */
export type MapEventOp<V> = readonly [field: string, value: V | null, ...parentIdxToDelete: number[]];

/** Range query payload for a CRDT multimap.  */
export interface MapRangeQuery<K, V>
  extends AggregateQuery<SyncOrAsyncIterable<[field: string, value: V]>>, MapRangeQueryOptions<K, string> { }

/** Range query options for a CRDT multimap.  */
export interface MapRangeQueryOptions<K, F = string> {
  /** Key to target aggregate root. */
  readonly root: K;

  /** Returns only entries with field names greater than or equal to given name. */
  readonly gte?: F;

  /** Returns only entries with field names less than or equal to given name. */
  readonly lte?: F;

  /** Returns entries in reverse order. */
  readonly reverse?: boolean;

  /** Maximum number of results to return. Defaults to `Infinity`. */
  readonly limit?: number;
}
