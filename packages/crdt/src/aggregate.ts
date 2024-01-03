import { AbortOptions, MaybePromise } from '@mithic/commons';

/** Aggregate command haler. */
export interface AggregateCommandHandler<State, Command, Event> {
  /** Handles a command and produces an event. */
  handle(store: State, command: Command, options?: AbortOptions): MaybePromise<Event | undefined>;
}

/** Aggregate state projection. */
export interface AggregateProjection<State, Event> {
  /** Applies an event to state. */
  reduce(store: State, event: Event, options?: AbortOptions): MaybePromise<State>;

  /** Validates an event and returns any error. */
  validate(store: State, event: Event, options?: AbortOptions): MaybePromise<Error | undefined>;
}
