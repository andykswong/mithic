import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SimpleMessageBus } from '@mithic/messaging';
import { ReduceStore } from '../store.ts';

type State = { count: number; };
type Event = { type: string };
const TOPIC = 'message';
const INCR_EVENT: Event = { type: 'increment' };

describe(ReduceStore.name, () => {
  let bus: SimpleMessageBus<Event>;
  let store: ReduceStore<State, Event>;

  beforeEach(async () => {
    const initialState = { count: 0 };
    const reducer = jest.fn((state: State, event: Event) =>
      (event.type === INCR_EVENT.type ? { ...state, count: state.count + 1 } : state)
    );
    bus = new SimpleMessageBus<Event>();
    store = new ReduceStore(reducer, initialState, bus);
    await store.start();
  });

  afterEach(async () => {
    await store.close();
  });

  describe('close', () => {
    it('should set started to false', async () => {
      await store.close();
      expect(store.started).toBe(false);
    });
  });

  it('should have started', () => {
    expect(store.started).toBe(true);
  });

  it('should dispatch commands and update state', async () => {
    await bus.dispatch(INCR_EVENT);
    expect(store.getState()).toEqual({ count: 1 });
  });

  it('should subscribe to changes and invoke the consumer function', async () => {
    const consumerFn = jest.fn(() => undefined);
    const unsubscribe = await store.subscribe(consumerFn);
    await bus.dispatch(INCR_EVENT, { topic: TOPIC });
    expect(store.getState()).toEqual({ count: 1 });
    expect(consumerFn).toHaveBeenCalledTimes(1);
    expect(consumerFn).toHaveBeenCalledWith(store.getState(), { topic: TOPIC });

    await unsubscribe();
    await bus.dispatch(INCR_EVENT);
    expect(store.getState()).toEqual({ count: 2 });
    expect(consumerFn).toHaveBeenCalledTimes(1);
  });

  it('should be async iterable for listening to state changes', async () => {
    setTimeout(() => bus.dispatch(INCR_EVENT));
    let i = 1;
    for await (const state of store) {
      expect(state).toEqual({ count: i });
      if (++i > 1) {
        break;
      }
      await bus.dispatch(INCR_EVENT);
    }
  });
});
