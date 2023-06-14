import { AbortOptions, CodedError, MaybePromise } from '@mithic/commons';
import { Event, EventMetadata } from '@mithic/eventstore';

/** Aggregate root type. */
export interface AggregateRoot<
  Command, QueryResult, Event extends AggregateEvent = AggregateEvent, QueryOptions extends AbortOptions = AbortOptions,
> {
  /** Accepted event types of this aggregate. */
  readonly event: Readonly<Record<string, Event['type']>>;

  /** Queries the state of this {@link AggregateRoot}. */
  query(options?: QueryOptions): QueryResult;

  /** Handles a command and produces an event. */
  command(command: Command, options?: AbortOptions): MaybePromise<Event>;

  /** Applies given event. */
  apply(event: Event, options?: AbortOptions): MaybePromise<void>;
  
  /** Validates given event. */
  validate(event: Event, options?: AbortOptions): MaybePromise<CodedError | undefined>;
}

/** Aggregate event type. */
export interface AggregateEvent<
  A extends string = string, K = unknown, T = unknown
> extends Event<T, EventMetadata<K>> {
  type: A;
}
