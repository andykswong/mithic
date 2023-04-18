import { MaybePromise } from '@mithic/commons';
import { EventConsumer, EventSubscription, Unsubscribe } from '../event.js';
import { SimpleEventBus } from '../event/index.js';
import { EventProcessor } from '../processor.js';

/** {@link EventProcessor} that derives aggregate state from events. */
export class EventReducer<Event = unknown, State = object>
  extends EventProcessor<Event>
  implements EventSubscription<State>
{
  protected readonly eventBus = new SimpleEventBus<State>();
  protected _state: State;

  public constructor(
    /** {@link EventSubscription} to consume. */
    subscription: EventSubscription<Event>,
    /** Reducer function. */
    reducer: EventReducerFn<Event, State>,
    /** Initial state. */
    initialState: State,
  ) {
    const consumer = (event: Event) => MaybePromise.map(reducer(this._state, event), this.setState);
    super(subscription, consumer);
    this._state = initialState;
  }

  /** Returns the current state. */
  public get state(): State {
    return this._state;
  }

  public subscribe(consumer: EventConsumer<State>): Unsubscribe {
    return this.eventBus.subscribe(consumer);
  }

  private setState = (state: State) => {
    this._state = state;
    this.eventBus.dispatch(state);
  };
}

/** Event reducer function. */
export type EventReducerFn<Event = unknown, State = object> = (state: State, event: Event) => MaybePromise<State>;
