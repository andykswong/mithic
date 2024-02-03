import { AbortOptions, AsyncDisposableCloseable, MaybePromise, Startable } from '@mithic/commons';
import {
  MessageBus, MessageHandler, MessageSubscription, SimpleMessageBus, StateProvider, Unsubscribe
} from '@mithic/messaging';
import { AsyncSubscriber, AsyncSubscriberOptions } from '../iterator.ts';
import { MessageReducer } from '../processor/index.ts';
import { MessageReduceHandler } from '../handler.ts';

/** Interface for a store that can be subscribed for changes. */
export interface ReactiveStore<State = unknown>
  extends StateProvider<State>, MessageSubscription<State>, Startable {

  /** Returns an async iterator that yields the latest state on change. */
  iterator(options?: AsyncSubscriberOptions): AsyncIterableIterator<State>;
}

/** A {@link ReactiveStore} that is updated by a reducer function. */
export class ReduceStore<State, Event, HandlerOpts = object>
  extends AsyncDisposableCloseable
  implements ReactiveStore<State>, AsyncDisposable, AsyncIterable<State> {

  /** Reducer to use. */
  protected readonly reducer: MessageReducer<State, Event, HandlerOpts>;

  public constructor(
    /** Reducer function. */
    reducer: MessageReduceHandler<State, Event, HandlerOpts>,
    /** Initial state. */
    initialState: State,
    /** Event subscription to use. */
    subscription: MessageSubscription<Event, HandlerOpts>,
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

  public subscribe(consumer: MessageHandler<State>): MaybePromise<Unsubscribe> {
    return this.eventBus.subscribe(consumer);
  }

  public iterator(options?: AsyncSubscriberOptions): AsyncIterableIterator<State> {
    return new AsyncSubscriber(this, options);
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<State> {
    return this.iterator({ bufferSize: 32 });
  }
}
