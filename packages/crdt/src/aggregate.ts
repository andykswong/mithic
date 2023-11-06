import { AbortOptions, MaybePromise } from '@mithic/commons';

/** Aggregate processor type. */
export interface Aggregate<Command, Event, Query, K = unknown> {
  /** Queries the state of this {@link Aggregate}. */
  query(query: Query, options?: AbortOptions): AggregateQueryResult<Query>;

  /** Handles a command and produces an event. */
  command(command: Command, options?: AbortOptions): MaybePromise<Event>;

  /** Applies given event. */
  reduce(event: Event, options?: AbortOptions): MaybePromise<K>;

  /** Validates given event and returns any error. */
  validate(event: Event, options?: AbortOptions): MaybePromise<Error | undefined>;
}

declare const ResultMarker: unique symbol;

/** Aggregate query object type. */
export interface AggregateQuery<Result = unknown> {
  /** Result type marker */
  [ResultMarker]?: Result;
}

/** Aggregate query result type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AggregateQueryResult<Query> = Query extends AggregateQuery<infer Result> ? Result : any;
