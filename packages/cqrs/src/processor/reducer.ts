import { MaybePromise } from '@mithic/commons';
import { MessageConsumer, MessageSubscription, Unsubscribe } from '../bus.js';
import { SimpleMessageBus } from '../bus/index.js';
import { MessageProcessor } from '../processor.js';

/** {@link MessageProcessor} that derives aggregate state from messages. */
export class MessageReducer<Msg = unknown, State = object>
  extends MessageProcessor<Msg>
  implements MessageSubscription<State>
{
  protected readonly eventBus = new SimpleMessageBus<State>();
  protected _state: State;

  public constructor(
    /** {@link MessageSubscription} to consume. */
    subscription: MessageSubscription<Msg>,
    /** Reducer function. */
    reducer: MessageReducerFn<Msg, State>,
    /** Initial state. */
    initialState: State,
  ) {
    const consumer = (event: Msg) => MaybePromise.map(reducer(this._state, event), this.setState);
    super(subscription, consumer);
    this._state = initialState;
  }

  /** Returns the current state. */
  public get state(): State {
    return this._state;
  }

  public subscribe(consumer: MessageConsumer<State>): Unsubscribe {
    return this.eventBus.subscribe(consumer);
  }

  private setState = (state: State) => {
    this._state = state;
    this.eventBus.dispatch(state);
  };
}

/** Reducer function. */
export type MessageReducerFn<Msg = unknown, State = object> = (state: State, message: Msg) => MaybePromise<State>;
