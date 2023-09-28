import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MessageDispatcher, MessageSubscription } from '../bus.js';
import { MessageProcessor } from '../processor.js';

/** {@link MessageProcessor} that derives aggregate state from messages. */
export class MessageReducer<State = object, Msg = unknown> extends MessageProcessor<Msg> {
  protected _state: State;

  public constructor(
    /** {@link MessageSubscription} to consume. */
    subscription: MessageSubscription<Msg>,
    /** Output {@link MessageDispatcher} to use. */
    protected readonly dispatcher: MessageDispatcher<State>,
    /** Reducer function. */
    reducer: MessageReducerFn<State, Msg>,
    /** Initial state. */
    initialState: State,
  ) {
    const consumer = (event: Msg, options?: AbortOptions) =>
      MaybePromise.map(reducer(this._state, event, options), this.setState);
    super(subscription, consumer);
    this._state = initialState;
    this.getState = this.getState.bind(this);
  }

  /** Returns the current state. */
  public getState(): State {
    return this._state;
  }

  private setState = (state: State) => {
    this._state = state;
    this.dispatcher.dispatch(state);
  };
}

/** Reducer function of messages to state. */
export interface MessageReducerFn<State = unknown, Msg = unknown> {
  (state: State, message: Msg, options?: AbortOptions): MaybePromise<State>;
}
