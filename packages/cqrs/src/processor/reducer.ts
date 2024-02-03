import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MessageDispatcher, MessageSubscription } from '@mithic/messaging';
import { MessageProcessor } from '../processor.ts';
import { MessageReduceHandler } from '../handler.ts';

/** {@link MessageProcessor} that derives aggregate state from messages. */
export class MessageReducer<State = object, Msg = unknown, HandlerOpts = object>
  extends MessageProcessor<Msg, HandlerOpts> {

  protected _state: State;

  public constructor(
    /** {@link MessageSubscription} to consume. */
    subscription: MessageSubscription<Msg, HandlerOpts>,
    /** Output {@link MessageDispatcher} to use. */
    protected readonly dispatcher: MessageDispatcher<State>,
    /** Reducer function. */
    reducer: MessageReduceHandler<State, Msg, HandlerOpts>,
    /** Initial state. */
    initialState: State,
  ) {
    const consumer = (event: Msg, options?: AbortOptions & HandlerOpts) =>
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
