import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { delay } from '@mithic/commons';
import { SimpleMessageBus } from '@mithic/messaging';
import { MessageReducer } from '../reducer.ts';

const TOPIC = 'message';

describe(MessageReducer.name, () => {
  let subscription: SimpleMessageBus<string>;
  let state: { events: string[] };
  let dispatcher: SimpleMessageBus<typeof state>;
  let reduce: jest.MockedFunction<(s: typeof state, e: string) => typeof state>;

  beforeEach(() => {
    subscription = new SimpleMessageBus();
    dispatcher = new SimpleMessageBus();
    state = { events: [] };
    reduce = jest.fn((s, e) => {
      return { events: [...s.events, e] };
    })
  });

  describe('getState', () => {
    it('should return the current state', () => {
      const reducer = new MessageReducer(subscription, dispatcher, reduce, state);
      expect(reducer.getState()).toEqual(state);
    });
  });

  describe('consumer function', () => {
    it('should update state from messages using reducer function', async () => {
      const event = 'event';
      const event2 = 'event2';
      const reducer = new MessageReducer(subscription, dispatcher, reduce, state);

      await reducer.start();
      subscription.dispatch(event, { topic: TOPIC });

      expect(reduce).toHaveBeenLastCalledWith(state, event, { topic: TOPIC });
      const newState = { events: [event] };
      expect(reducer.getState()).toEqual(newState);

      subscription.dispatch(event2, { topic: TOPIC });

      expect(reduce).toHaveBeenLastCalledWith(newState, event2, { topic: TOPIC });
      expect(reducer.getState()).toEqual({ events: [event, event2] });
    });

    it('should work with async reducer function', async () => {
      const event = 'event';
      const reducer = new MessageReducer(subscription, dispatcher, async (s, e) => {
        return { events: [...s.events, e] };
      }, state);

      await reducer.start();
      subscription.dispatch(event);
      await delay(); // wait for async reducer to finish

      expect(reducer.getState()).toEqual({ events: [event] });
    });

    describe('dispatcher', () => {
      it('should dispatch the latest state', async () => {
        const event = 'event';
        const reducer = new MessageReducer(subscription, dispatcher, (s, e) => {
          return { events: [...s.events, e] };
        }, state);

        const consumerFn = jest.fn(() => undefined);

        await reducer.start();
        dispatcher.subscribe(consumerFn);
        subscription.dispatch(event, { topic: TOPIC });

        expect(consumerFn).toHaveBeenCalledWith({ events: [event] }, { topic: TOPIC });
      });
    });
  });
});
