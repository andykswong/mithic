import { jest } from '@jest/globals';
import { SimpleEventBus } from '../../event/index.js';
import { createReduxStore, ReduxStore, SimpleReduxStore } from '../redux.js';
import { EventReducer } from '../../processor/index.js';
import { EventConsumer } from '../../event.js';

type State = { count: number; };
type Event = { type: string };
const INCR_EVENT: Event = { type: 'increment' };

describe(createReduxStore.name, () => {
  it('should create a SimpleReduxStore with event bus, initial state and reducer function', async () => {
    // Setup test data
    const initialState = { count: 0 };
    const reducer = jest.fn((state: State, event: Event) =>
      (event.type === INCR_EVENT.type ? { ...state, count: state.count + 1 } : state)
    );
    const eventBus = new SimpleEventBus<Event>();

    const store = createReduxStore({ initialState, reducer, eventBus });
    await store.start();

    expect(store.started).toBe(true);
    expect(store.getState()).toEqual(initialState);

    const consumerFn = jest.fn<EventConsumer<State>>();
    const unsubscribe = await store.subscribe(consumerFn);

    await store.dispatch({ type: 'increment' });
    expect(reducer).toHaveBeenCalledWith(initialState, { type: 'increment' });
    expect(store.getState()).toEqual({ count: 1 });
    expect(consumerFn).toHaveBeenCalledTimes(1);
    expect(consumerFn).toHaveBeenCalledWith(store.getState());

    await unsubscribe();
    await store.dispatch({ type: 'increment' });
    expect(consumerFn).toHaveBeenCalledTimes(1);

    await store.close();
    expect(store.started).toBe(false);
  });
});

describe(SimpleReduxStore.name, () => {
  let store: ReduxStore<State, Event>;

  beforeEach(async () => {
    const initialState = { count: 0 };
    const reducer = jest.fn((state: State, event: Event) =>
      (event.type === INCR_EVENT.type ? { ...state, count: state.count + 1 } : state)
    );
    const eventBus = new SimpleEventBus<Event>();

    store = new SimpleReduxStore(eventBus, new EventReducer(eventBus, reducer, initialState));
    await store.start();
    expect(store.started).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    expect(store.started).toBe(false);
  });

  it('should dispatch events and update state', async () => {
    await store.dispatch(INCR_EVENT);
    expect(store.getState()).toEqual({ count: 1 });
  });

  it('should subscribe to changes and invoke the consumer function', async () => {
    const consumerFn = jest.fn<EventConsumer<State>>();
    const unsubscribe = await store.subscribe(consumerFn);
    await store.dispatch(INCR_EVENT);
    expect(store.getState()).toEqual({ count: 1 });
    expect(consumerFn).toHaveBeenCalledTimes(1);
    expect(consumerFn).toHaveBeenCalledWith(store.getState());

    await unsubscribe();
    await store.dispatch(INCR_EVENT);
    expect(store.getState()).toEqual({ count: 2 });
    expect(consumerFn).toHaveBeenCalledTimes(1);
  });
});
