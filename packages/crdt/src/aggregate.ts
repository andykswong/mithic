import { AbortOptions, CodedError, MaybePromise } from '@mithic/commons';

/** Abstract aggregate type. */
export interface Aggregate<
  Command,
  EventRef, Event extends AggregateEvent<string, EventRef>,
  QueryResult, QueryOptions extends AbortOptions = AbortOptions,
> {
  /** Accepted event types of this aggregate. */
  readonly event: Readonly<Record<string, Event['type']>>;

  /** Queries the state of this {@link Aggregate}. */
  query(options?: QueryOptions): QueryResult;

  /** Handles a command and produces an event. */
  command(command: Command, options?: AbortOptions): MaybePromise<Event>;

  /** Applies given event and returns a reference to it. */
  apply(event: Event, options?: AggregateApplyOptions): MaybePromise<EventRef>;

  /** Validates given event and returns any error. */
  validate(event: Event, options?: AbortOptions): MaybePromise<CodedError | undefined>;
}

/** Aggregate event interface in Flux standard action format. */
export interface AggregateEvent<A extends string = string, Ref = unknown, T = unknown> {
  /** Event type. */
  readonly type: A;

  /** Event payload. */
  readonly payload: T;

  /** Event metadata. */
  readonly meta: AggregateEventMeta<Ref>;
}

/** {@link AggregateEvent} metadata. */
export interface AggregateEventMeta<Ref = unknown> {
  /** Parent event references, on which this event depends. */
  readonly parents: readonly Ref[];

  /** Event target aggregate root ID. */
  readonly root?: Ref;

  /** (Logical) timestamp at which the event is created/persisted. */
  readonly createdAt?: number;
}

/** Common metadata for {@link Aggregate} command. */
export interface AggregateCommandMeta<Ref> {
  /** Reference to (root event of) the target aggregate. Creates a new aggregate if not specified. */
  readonly ref?: Ref;

  /** Timestamp of this command. */
  readonly createdAt?: number;

  /** A random number to make a unique event when creating a new aggregate. */
  readonly nonce?: number;
}

/** Options for {@link Aggregate} apply method. */
export interface AggregateApplyOptions extends AbortOptions {
  /** Whether to validate input. Defaults to true. */
  readonly validate?: boolean;
}
