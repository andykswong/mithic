import { StandardCommand, StandardEvent } from '../action.js';
import { AggregateCommandHandler, AggregateProjection } from '../aggregate.js';
import { EntityStore, ReadonlyEntityStore } from '../store.js';

/** {@link AggregateCommandHandler} for a CRDT entity. */
export type EntityCommandHandler<Id, V> =
  AggregateCommandHandler<ReadonlyEntityStore<Id, V>, EntityCommand<Id, V>, EntityEvent<Id, V>>;

/** {@link AggregateProjection} for a CRDT entity. */
export type EntityProjection<Id, V> =
  AggregateProjection<EntityStore<Id, V>, EntityEvent<Id, V>>;

/** Command type for a CRDT entity. */
export enum EntityCommandType {
  /** Update entity attributes. */
  Update = 'ENTITY_OPS',
}

/** Command for a CRDT entity. */
export type EntityCommand<Id, V> = StandardCommand<EntityCommandType, EntityCommandPayload<V>, Id>;

/** Command payload for a CRDT entity. */
export interface EntityCommandPayload<V> {
  /** Commands on attributes. */
  readonly cmd: { readonly [attr: string]: EntityAttrCommand<V>; };

  /** Type of the entity. */
  readonly type?: string;
}

/** Command payload for a CRDT entity attribute. */
export interface EntityAttrCommand<V> {
  /** Adds given set of values to attribute. */
  readonly add?: readonly V[];

  /** Removes all existing copies of given values to attribute, or all values if `true`. */
  readonly del?: readonly V[] | true;

  /** Sets attribute to specified value, removing all existing values. */
  readonly set?: V;

  /**
   * Deletes given number of values at or after specified list index, and
   * inserts given list of values before specified index.
   */
  readonly splice?: readonly [index: string, deleteCount: number, ...values: V[]];
}

/** Event type for a CRDT entity. */
export enum EntityEventType {
  /** Creates a new entity. */
  New = 'ENTITY_NEW',

  /** Updates entity attributes. */
  Update = 'ENTITY_OPS',
}

/** Event for a CRDT entity. */
export type EntityEvent<Id, V> = StandardEvent<EntityEventType, EntityEventPayload<V>, Id>;

/** Event payload for a CRDT entity. */
export interface EntityEventPayload<V> {
  /**
   * Operations to upsert tagged values into given attributes, and delete existing values at given parent link indices.
   */
  readonly ops: readonly EntityEventOp<V>[];

  /** Type of the entity. */
  readonly type?: string;
}

/** Operation in a CRDT entity event. */
export type EntityEventOp<V> = readonly [attr: string, tag: string, value: V | null, ...parentIdxToDelete: number[]];
