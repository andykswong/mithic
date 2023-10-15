import { AbortOptions, MaybePromise } from '@mithic/commons';

/** Abstract aggregate type. */
export interface Aggregate<
  Command, Event,
  QueryResult, QueryOptions extends AbortOptions = AbortOptions,
> {
  /** Queries the state of this {@link Aggregate}. */
  query(options?: QueryOptions): QueryResult;

  /** Handles a command and produces an event. */
  command(command: Command, options?: AbortOptions): MaybePromise<Event>;

  /** Applies given event. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reduce(event: Event, options?: AggregateReduceOptions): MaybePromise<any>;

  /** Validates given event and returns any error. */
  validate(event: Event, options?: AbortOptions): MaybePromise<Error | undefined>;
}

/** Options for {@link Aggregate} reduce method. */
export interface AggregateReduceOptions extends AbortOptions {
  /** Whether to validate input. Defaults to true. */
  readonly validate?: boolean;
}
