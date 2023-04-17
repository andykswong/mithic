import { AbortOptions, MaybePromise, Startable } from '@mithic/commons';
import { EventBus, EventConsumer, EventDispatcher, EventSubscription, Unsubscribe } from '../event.js';
import { AsyncEventSubscriber, SimpleEventBus } from '../event/index.js';
import { EventReducer, EventReducerFn } from '../processor/index.js';

/** Creates a simple Redux-compatible CQRS store using {@link EventBus} and {@link EventReducer}. */
export function createReduxStore<State, Event>(
  options: CreateReduxStoreOptions<State, Event>
): ReduxStore<State, Event> {
  const eventBus = options.eventBus ?? new SimpleEventBus();
  const eventReducer = new EventReducer(eventBus, options.reducer, options.initialState);
  return new SimpleReduxStore(eventBus, eventReducer);
}

/** Simple implementation of {@link ReduxStore}. */
export class SimpleReduxStore<State, Event> implements ReduxStore<State, Event> {
  public constructor(
    /** Event dispatcher to use. */
    protected readonly eventDispatcher: EventDispatcher<Event>,
    /** Event reducer to use. */
    protected readonly eventReducer: EventReducer<Event, State>,
  ) {
  }

  public get started(): boolean {
    return this.eventReducer.started;
  }

  public start(options?: AbortOptions): MaybePromise<void> {
    return this.eventReducer.start(options);
  }

  public close(options?: AbortOptions): MaybePromise<void> {
    return this.eventReducer.close(options);
  }

  public dispatch = (event: Event, options?: AbortOptions): MaybePromise<void> => {
    return this.eventDispatcher.dispatch(event, options);
  };

  public getState(): State {
    return this.eventReducer.state;
  }

  public subscribe(consumer: EventConsumer<State>): Unsubscribe {
    return this.eventReducer.subscribe(consumer);
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<State> {
    return new AsyncEventSubscriber(this, { bufferSize: 2 });
  }
}

/** Options for {@link createReduxStore}. */
export interface CreateReduxStoreOptions<State, Event> {
  /** Event bus to use. */
  eventBus?: EventBus<Event>;

  /** Initial state. */
  initialState: State;

  /** Event reducer function. */
  reducer: EventReducerFn<Event, State>;
}

/** Interface for a Redux compatible store. */
export interface ReduxStore<State = unknown, Event = unknown>
  extends EventDispatcher<Event>, EventSubscription<State>, Startable, AsyncIterable<State> {

  /** Returns the current state. */
  getState(): State;
} 
