import { StandardCommand, StandardEvent } from '../action.js';
import { AggregateCommandHandler, AggregateProjection } from '../aggregate.js';
import { EntityStoreProvider, ReadonlyEntityStoreProvider } from '../store/index.js';

/** {@link AggregateCommandHandler} for a CRDT multimap. */
export type MapCommandHandler<K, V> =
  AggregateCommandHandler<ReadonlyEntityStoreProvider<K, V>, MapCommand<K, V>, MapEvent<K, V>>;

/** {@link AggregateProjection} for a CRDT multimap. */
export type MapProjection<K, V> =
  AggregateProjection<EntityStoreProvider<K, V>, MapEvent<K, V>>;

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

  /** Type of the map. */
  readonly type?: string;
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

  /** Type of the map. */
  readonly type?: string;
}

/** Operation in a CRDT multimap event. */
export type MapEventOp<V> = readonly [field: string, value: V | null, ...parentIdxToDelete: number[]];
