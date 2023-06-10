import { ContentId } from '@mithic/commons';

/** An event object. */
export interface Event<T = unknown, Meta = unknown> {
  /** Event type. */
  readonly type: string;

  /** Event payload. */
  readonly payload: T;

  /** Event metadata. */
  readonly meta: Meta;
}

/** Standard {@link Event} metadata. */
export interface EventMetadata<K = ContentId> {
  /** Parent event ID, on which this event depends. */
  readonly parents: readonly K[];

  /** Event target aggregate root ID. */
  readonly root?: K;

  /** (Logical) timestamp at which the event is created/persisted. */
  readonly createdAt?: number;
}
