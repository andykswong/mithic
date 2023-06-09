import { ContentId } from '@mithic/commons';

/** An event object. */
export interface Event<T = unknown, Meta = unknown> {
  /** Event type. */
  type: string;

  /** Event payload. */
  payload: T;

  /** Event metadata. */
  meta: Meta;
}

/** Standard {@link Event} metadata. */
export interface EventMetadata<Id = ContentId> {
  /** Parent event IDs, on which this event depends. */
  parents: Id[];

  /** Event target aggregate root ID. */
  root?: Id;

  /** (Logical) timestamp at which the event is created/persisted. */
  createdAt?: number;
}
