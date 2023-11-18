import { AbortOptions, MaybePromise } from '@mithic/commons';

/** Aggregate command haler. */
export interface AggregateCommandHandler<Store, Command, Event> {
  /** Handles a command and produces an event. */
  handle(store: Store, command: Command, options?: AbortOptions): MaybePromise<Event | undefined>;
}

/** Aggregate state projection. */
export interface AggregateProjection<Store, Event> {
  /** Applies an event to state. */
  reduce(store: Store, event: Event, options?: AbortOptions): MaybePromise<Store>;

  /** Validates an event and returns any error. */
  validate(store: Store, event: Event, options?: AbortOptions): MaybePromise<Error | undefined>;
}

/** Aggregate state query resolver. */
export interface AggregateQueryResolver<Store, Query> {
  /** Resolves query to current state. */
  resolve(store: Store, query: Query, options?: AbortOptions): AggregateQueryResult<Query>;
}

declare const ResultMarker: unique symbol;

/** Aggregate query object type. */
export interface AggregateQuery<Result = unknown> {
  /** Result type marker */
  [ResultMarker]?: Result;
}

/** Aggregate query result type. */
export type AggregateQueryResult<Query> = Query extends AggregateQuery<infer Result> ? Result : unknown;
