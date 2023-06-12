import { jest } from '@jest/globals';
import { delay } from '@mithic/commons';
import { MessageConsumer } from '../../bus.js';
import { SimpleMessageBus } from '../../bus/index.js';
import { MessageReducer } from '../reducer.js';

describe(MessageReducer.name, () => {
  let subscription: SimpleMessageBus<string>;
  let state: { events: string[] };
  let reduce: jest.MockedFunction<(s: typeof state, e: string) => typeof state>;

  beforeEach(() => {
    subscription = new SimpleMessageBus();
    state = { events: [] };
    reduce = jest.fn((s, e) => {
      return { events: [...s.events, e] };
    })
  });

  describe('getState', () => {
    it('should return the current state', () => {
      const reducer = new MessageReducer(subscription, reduce, state);
      expect(reducer.state).toEqual(state);
    });
  });

  describe('consumer function', () => {
    it('should update state from messages using reducer function', async () => {
      const event = 'event';
      const event2 = 'event2';
      const reducer = new MessageReducer(subscription, reduce, state);

      await reducer.start();
      subscription.dispatch(event);

      expect(reduce).toHaveBeenLastCalledWith(state, event);
      const newState = { events: [event] };
      expect(reducer.state).toEqual(newState);

      subscription.dispatch(event2);

      expect(reduce).toHaveBeenLastCalledWith(newState, event2);
      expect(reducer.state).toEqual({ events: [event, event2] });
    });

    it('should work with async reducer function', async () => {
      const event = 'event';
      const reducer = new MessageReducer(subscription, async (s, e) => {
        return { events: [...s.events, e] };
      }, state);

      await reducer.start();
      subscription.dispatch(event);
      await delay(); // wait for async reducer to finish

      expect(reducer.state).toEqual({ events: [event] });
    });

    describe('subscribe', () => {
      it('should subscribe consumer to latest state', async () => {
        const event = 'event';
        const reducer = new MessageReducer(subscription, (s, e) => {
          return { events: [...s.events, e] };
        }, state);

        const consumerFn = jest.fn<MessageConsumer<typeof state>>();

        await reducer.start();
        reducer.subscribe(consumerFn);
        subscription.dispatch(event);

        expect(consumerFn).toHaveBeenCalledWith({ events: [event] });
      });

      it('should not call consumer after it has unsubscribed', async () => {
        const event = 'event';
        const reducer = new MessageReducer(subscription, (s, e) => {
          return { events: [...s.events, e] };
        }, state);

        const consumerFn = jest.fn<MessageConsumer<typeof state>>();

        await reducer.start();
        const unsubscribe = reducer.subscribe(consumerFn);
        unsubscribe();
        subscription.dispatch(event);

        expect(consumerFn).not.toHaveBeenCalled();
      });
    });
  });
});
