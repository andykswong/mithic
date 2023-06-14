import { AbortOptions, MaybePromise } from '@mithic/commons';
import { Event, EventMetadata } from '@mithic/eventstore';

/** Aggregate type. */
export interface Aggregate<
  Event extends AggregateEvent,
  Commands extends AggregateCommands<Event>,
  Queries extends AggregateQueries
> {
  /** Accepted event types of this aggregate. */
  readonly event: Readonly<Record<string, Event['type']>>;

  /** Commands of this aggregate. */
  readonly command: Commands;

  /** Queries of this aggregate. */
  readonly query: Queries;

  /** Handles given event. */
  handle(event: Event, options?: AbortOptions): MaybePromise<void>;
}

/** Aggregate event type. */
export interface AggregateEvent<
  A extends string = string, K = unknown, T = unknown
> extends Event<T, EventMetadata<K>> {
  type: A;
}

/** Interface for the commands of an {@link Aggregate}, where each command generates an event. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AggregateCommands<E, K extends string = string, Args extends unknown[] = any[]> =
  Record<K, (...args: Args) => MaybePromise<E>>;

/** Interface for the queries of an {@link Aggregate}. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AggregateQueries<K extends string = string, Args extends unknown[] = any[], Result = unknown> =
  Record<K, (...args: Args) => MaybePromise<Result>>;
