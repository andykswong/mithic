import { AbortOptions, MaybePromise } from '@mithic/commons';
import { MessageBus, MessageDispatcher } from '../bus.js';
import { SimpleMessageBus } from '../bus/index.js';
import { MessageReducerFn } from '../processor/index.js';
import { ReactiveStore, ReduceStore } from './store.js';

/** {@link ReduceStore} with Redux-compatible interface. */
export class ReduxStore<State, Event, Action = Event>
  extends ReduceStore<State, Event>
  implements ReactiveStore<State>, MessageDispatcher<Action> {

  public constructor(
    /** Reducer function. */
    reducer: MessageReducerFn<State, Event>,
    /** Initial state. */
    initialState: State,
    /** {@link MessageBus} to use. */
    protected readonly bus = new SimpleMessageBus() as MessageBus<Action, Event>,
  ) {
    super(reducer, initialState, bus);
    this.dispatch = this.dispatch.bind(this);
  }

  public dispatch(action: Action, options?: AbortOptions): MaybePromise<void> {
    return this.bus.dispatch(action, options);
  }
}
