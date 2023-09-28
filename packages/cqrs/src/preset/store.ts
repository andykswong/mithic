import { AbortOptions, AsyncDisposableCloseable, MaybePromise, Startable } from '@mithic/commons';
import { MessageBus, MessageConsumer, MessageSubscription, Unsubscribe } from '../bus.js';
import { AsyncSubscriber, AsyncSubscriberOptions } from '../iterator.js';
import { MessageReducer, MessageReducerFn } from '../processor/index.js';
import { SimpleMessageBus } from '../bus/index.js';

/** Interface for a simple stateful store. */
export interface Store<State = unknown> {
  /** Returns the current state. */
  getState(): State;
}

/** Interface for a store that can be subscribed for changes. */
export interface ReactiveStore<State = unknown> extends Store<State>, MessageSubscription<State>, Startable {
  /** Returns an async iterator that yields the latest state on change. */
  iterator(options?: AsyncSubscriberOptions): AsyncIterableIterator<State>;
}

/** A {@link ReactiveStore} that is updated by a reducer function. */
export class ReduceStore<State, Event>
  extends AsyncDisposableCloseable
  implements ReactiveStore<State>, AsyncDisposable, AsyncIterable<State> {

  /** Reducer to use. */
  protected readonly reducer: MessageReducer<State, Event>;

  public constructor(
    /** Reducer function. */
    reducer: MessageReducerFn<State, Event>,
    /** Initial state. */
    initialState: State,
    /** Event subscription to use. */
    subscription: MessageSubscription<Event>,
    /** Output event bus. */
    protected readonly eventBus: MessageBus<State> = new SimpleMessageBus(),
  ) {
    super();
    this.reducer = new MessageReducer(subscription, eventBus, reducer, initialState);
    this.getState = this.getState.bind(this);
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

  public getState(): State {
    return this.reducer.getState();
  }

  public subscribe(consumer: MessageConsumer<State>): MaybePromise<Unsubscribe> {
    return this.eventBus.subscribe(consumer);
  }

  public iterator(options?: AsyncSubscriberOptions): AsyncIterableIterator<State> {
    return new AsyncSubscriber(this, options);
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<State> {
    return this.iterator({ bufferSize: 32 });
  }
}
