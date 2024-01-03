import { AggregateCommandHandler, AggregateProjection } from '../aggregate.js';
import { StandardCommand, StandardEvent } from '../action.js';
import { EntityStoreProvider, ReadonlyEntityStoreProvider } from '../store/index.js';

/** {@link AggregateCommandHandler} for a CRDT set. */
export type SetCommandHandler<K, V> =
  AggregateCommandHandler<ReadonlyEntityStoreProvider<K, V>, SetCommand<K, V>, SetEvent<K, V>>;

/** {@link AggregateProjection} for a CRDT set. */
export type SetProjection<K, V> =
  AggregateProjection<EntityStoreProvider<K, V>, SetEvent<K, V>>;

/** Command type for a CRDT set. */
export enum SetCommandType {
  /** Sets or deletes set fields. */
  Update = 'SET_OPS',
}

/** Command for a CRDT set. */
export type SetCommand<K, V> = StandardCommand<SetCommandType, SetCommandPayload<V>, K>;

/** Command payload for a CRDT set. */
export interface SetCommandPayload<V> {
  /** Adds given values to the set. */
  readonly add?: readonly V[];

  /** Deletes all copies of given values from the set. */
  readonly del?: readonly V[];

  /** Type of the set. */
  readonly type?: string;

  /** Namespace of set hash keys. Defaults to `$val`. */
  readonly ns?: string;
}

/** Event type for a CRDT set. */
export enum SetEventType {
  /** Creates a new set. */
  New = 'SET_NEW',

  /** Adds or deletes values in the set. */
  Update = 'SET_OPS',
}

/** Event for a CRDT set. */
export type SetEvent<K, V> = StandardEvent<SetEventType, SetEventPayload<V>, K>;

/** Event payload for a CRDT set. */
export interface SetEventPayload<V> {
  /** Operations to add or delete given values in the set. */
  readonly set: SetEventOp<V>[];

  /** Type of the set. */
  readonly type?: string;

  /** Namespace of set hash keys. Default to no namespace. */
  readonly ns?: string;
}

/** Operation in a CRDT set event. */
export type SetEventOp<V> = readonly [value: V, isAdd: boolean, ...parentIdxToDelete: number[]];
