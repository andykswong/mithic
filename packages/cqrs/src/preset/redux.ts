import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MessageBus, MessageDispatcher, SimpleMessageBus } from '@mithic/messaging';
import { MessageReduceHandler } from '../handler.ts';
import { ReactiveStore, ReduceStore } from './store.ts';

/** {@link ReduceStore} with Redux-compatible interface. */
export class ReduxStore<State, Event, Action = Event>
  extends ReduceStore<State, Event>
  implements ReactiveStore<State>, MessageDispatcher<Action> {

  public constructor(
    /** Reducer function. */
    reducer: MessageReduceHandler<State, Event>,
    /** Initial state. */
    initialState: State,
    /** {@link MessageBus} to use. */
    protected readonly bus = new SimpleMessageBus() as unknown as MessageBus<Action, Event>,
  ) {
    super(reducer, initialState, bus);
    this.dispatch = this.dispatch.bind(this);
  }

  public dispatch(action: Action, options?: AbortOptions): MaybePromise<void> {
    return this.bus.dispatch(action, options);
  }
}
