import { AggregateCommandHandler, AggregateProjection } from '../aggregate.js';
import { StandardCommand, StandardEvent } from '../action.js';
import { MapEventPayload } from '../map/index.js';
import { EntityStoreProvider, ReadonlyEntityStoreProvider } from '../store/index.js';

/** {@link AggregateCommandHandler} for List CRDT. */
export type ListCommandHandler<K, V> =
  AggregateCommandHandler<ReadonlyEntityStoreProvider<K, V>, ListCommand<K, V>, ListEvent<K, V>>;

/** {@link AggregateProjection} for List CRDT. */
export type ListProjection<K, V> =
  AggregateProjection<EntityStoreProvider<K, V>, ListEvent<K, V>>;

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

  /** Type of the list. */
  readonly type?: string;

  /** Namespace of list indices. Defaults to `$idx`. */
  readonly ns?: string;
}

/** Event for List CRDT. */
export type ListEvent<K, V> = StandardEvent<ListEventType, ListEventPayload<V>, K>;

/** Event type for List CRDT. */
export enum ListEventType {
  /** Creates a new List. */
  New = 'LIST_NEW',

  /** Inserts or deletes values in the List. */
  Update = 'LIST_OPS',
}

/** Event payload for List CRDT. */
export interface ListEventPayload<V> extends MapEventPayload<V> {
  /** Namespace of list indices. Defaults to no namespace. */
  readonly ns?: string;
}
