import { jest } from '@jest/globals';
import { wait } from '@mithic/commons';
import { EventConsumer } from '../../event.js';
import { SimpleEventBus } from '../../event/index.js';
import { EventReducer } from '../reducer.js';

describe(EventReducer.name, () => {
  let subscription: SimpleEventBus<string>;
  let state: { events: string[] };
  let reduce: jest.MockedFunction<(s: typeof state, e: string) => typeof state>;

  beforeEach(() => {
    subscription = new SimpleEventBus();
    state = { events: [] };
    reduce = jest.fn((s, e) => {
      return { events: [...s.events, e] };
    })
  });

  describe('getState', () => {
    it('should return the current state', () => {
      const eventReducer = new EventReducer(subscription, reduce, state);
      expect(eventReducer.state).toEqual(state);
    });
  });

  describe('consumer function', () => {
    it('should update state from event using reducer function', async () => {
      const event = 'event';
      const event2 = 'event2';
      const eventReducer = new EventReducer(subscription, reduce, state);

      await eventReducer.start();
      subscription.dispatch(event);

      expect(reduce).toHaveBeenLastCalledWith(state, event);
      const newState = { events: [event] };
      expect(eventReducer.state).toEqual(newState);

      subscription.dispatch(event2);

      expect(reduce).toHaveBeenLastCalledWith(newState, event2);
      expect(eventReducer.state).toEqual({ events: [event, event2] });
    });

    it('should work with async reducer function', async () => {
      const event = 'event';
      const eventReducer = new EventReducer(subscription, async (s, e) => {
        return { events: [...s.events, e] };
      }, state);

      await eventReducer.start();
      subscription.dispatch(event);
      await wait(); // wait for async reducer to finish

      expect(eventReducer.state).toEqual({ events: [event] });
    });

    describe('subscribe', () => {
      it('should subscribe consumer to latest state', async () => {
        const event = 'event';
        const eventReducer = new EventReducer(subscription, (s, e) => {
          return { events: [...s.events, e] };
        }, state);

        const consumerFn = jest.fn<EventConsumer<typeof state>>();

        await eventReducer.start();
        eventReducer.subscribe(consumerFn);
        subscription.dispatch(event);

        expect(consumerFn).toHaveBeenCalledWith({ events: [event] });
      });

      it('should not call consumer after it has unsubscribed', async () => {
        const event = 'event';
        const eventReducer = new EventReducer(subscription, (s, e) => {
          return { events: [...s.events, e] };
        }, state);

        const consumerFn = jest.fn<EventConsumer<typeof state>>();

        await eventReducer.start();
        const unsubscribe = eventReducer.subscribe(consumerFn);
        unsubscribe();
        subscription.dispatch(event);

        expect(consumerFn).not.toHaveBeenCalled();
      });
    });
  });
});
