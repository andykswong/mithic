import { jest } from '@jest/globals';
import { SimpleMessageBus } from '../../bus/index.js';
import { createReduxStore, ReduxStore, SimpleReduxStore } from '../redux.js';
import { MessageReducer } from '../../processor/index.js';
import { MessageConsumer } from '../../bus.js';

type State = { count: number; };
type Command = { type: string };
const INCR_EVENT: Command = { type: 'increment' };

describe(createReduxStore.name, () => {
  it('should create a SimpleReduxStore with message bus, initial state and reducer function', async () => {
    // Setup test data
    const initialState = { count: 0 };
    const reducer = jest.fn((state: State, event: Command) =>
      (event.type === INCR_EVENT.type ? { ...state, count: state.count + 1 } : state)
    );
    const bus = new SimpleMessageBus<Command>();

    const store = createReduxStore({ initialState, reducer, bus: bus });
    await store.start();

    expect(store.started).toBe(true);
    expect(store.getState()).toEqual(initialState);

    const consumerFn = jest.fn<MessageConsumer<State>>();
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
  let store: ReduxStore<State, Command>;

  beforeEach(async () => {
    const initialState = { count: 0 };
    const reducer = jest.fn((state: State, event: Command) =>
      (event.type === INCR_EVENT.type ? { ...state, count: state.count + 1 } : state)
    );
    const bus = new SimpleMessageBus<Command>();

    store = new SimpleReduxStore(bus, new MessageReducer(bus, reducer, initialState));
    await store.start();
    expect(store.started).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    expect(store.started).toBe(false);
  });

  it('should dispatch commands and update state', async () => {
    await store.dispatch(INCR_EVENT);
    expect(store.getState()).toEqual({ count: 1 });
  });

  it('should subscribe to changes and invoke the consumer function', async () => {
    const consumerFn = jest.fn<MessageConsumer<State>>();
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

  it('should be async iterable for listening to state changes', async () => {
    setTimeout(() =>store.dispatch(INCR_EVENT));
    let i = 1;
    for await (const state of store) {
      expect(state).toEqual({ count: i });
      if (++i > 1) {
        break;
      }
      await store.dispatch(INCR_EVENT);
    }
  });
});
