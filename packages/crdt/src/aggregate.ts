import { AbortOptions, CodedError, MaybePromise } from '@mithic/commons';

/** Aggregate root type. */
export interface AggregateRoot<
  Command, QueryResult,
  Event extends AggregateEvent = AggregateEvent, QueryOptions extends AbortOptions = AbortOptions,
> {
  /** Accepted event types of this aggregate. */
  readonly event: Readonly<Record<string, Event['type']>>;

  /** Queries the state of this {@link AggregateRoot}. */
  query(options?: QueryOptions): QueryResult;

  /** Handles a command and produces an event. */
  command(command: Command, options?: AbortOptions): MaybePromise<Event>;

  /** Applies given event. */
  apply(event: Event, options?: AggregateApplyOptions): MaybePromise<void>;
  
  /** Validates given event. */
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

/** Options for {@link AggregateRoot} apply method. */
export interface AggregateApplyOptions extends AbortOptions {
  /** Whether to validate input. Defaults to true. */
  readonly validate?: boolean;
}
