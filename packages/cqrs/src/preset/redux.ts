import { AbortOptions, AsyncDisposableCloseable, MaybePromise, Startable } from '@mithic/commons';
import { MessageBus, MessageConsumer, MessageDispatcher, MessageSubscription, Unsubscribe } from '../bus.js';
import { AsyncSubscriber, AsyncSubscriberOptions, SimpleMessageBus } from '../bus/index.js';
import { MessageReducer, MessageReducerFn } from '../processor/index.js';

/** Creates a simple Redux-compatible CQRS store using {@link MessageBus} and {@link MessageReducer}. */
export function createReduxStore<State, Msg>(
  options: CreateReduxStoreOptions<State, Msg>
): ReduxStore<State, Msg> {
  const bus = options.bus ?? new SimpleMessageBus();
  const reducer = new MessageReducer(bus, options.reducer, options.initialState);
  return new SimpleReduxStore(bus, reducer);
}

/** Simple implementation of {@link ReduxStore}. */
export class SimpleReduxStore<State, Command>
  extends AsyncDisposableCloseable
  implements ReduxStore<State, Command>, AsyncDisposable {

  public constructor(
    /** Dispatcher to use. */
    protected readonly dispatcher: MessageDispatcher<Command>,
    /** Reducer to use. */
    protected readonly reducer: MessageReducer<Command, State>,
  ) {
    super();
    this.dispatch = this.dispatch.bind(this);
  }

  public get started(): boolean {
    return this.reducer.started;
  }

  public start(options?: AbortOptions): MaybePromise<void> {
    return this.reducer.start(options);
  }

  public override close(options?: AbortOptions): MaybePromise<void> {
    return this.reducer.close(options);
  }

  public dispatch(event: Command, options?: AbortOptions): MaybePromise<void> {
    return this.dispatcher.dispatch(event, options);
  }

  public getState(): State {
    return this.reducer.state;
  }

  public subscribe(consumer: MessageConsumer<State>): Unsubscribe {
    return this.reducer.subscribe(consumer);
  }

  public iterator(options?: AsyncSubscriberOptions): AsyncIterableIterator<State> {
    return new AsyncSubscriber(this, options);
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<State> {
    return this.iterator({ bufferSize: 2 });
  }
}

/** Options for {@link createReduxStore}. */
export interface CreateReduxStoreOptions<State, Command> {
  /** Message bus to use. */
  bus?: MessageBus<Command>;

  /** Initial state. */
  initialState: State;

  /** Reducer function. */
  reducer: MessageReducerFn<Command, State>;
}

/** Interface for a Redux compatible store. */
export interface ReduxStore<State = unknown, Command = unknown>
  extends MessageDispatcher<Command>, MessageSubscription<State>, Startable, AsyncIterable<State> {

  /** Returns the current state. */
  getState(): State;

  /** Returns an async iterator that yields the latest state on change. */
  iterator(options?: AsyncSubscriberOptions): AsyncIterableIterator<State>;
} 
