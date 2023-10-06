import { jest } from '@jest/globals';
import { delay } from '@mithic/commons';
import { MessageBus, MessageHandler } from '../../messaging.js';
import { SimpleMessageBus } from '../../impl/simple.js';
import { applyDispatchMiddleware, applySubscribeMiddleware } from '../middleware.js';

const TOPIC = 'test';
const COMMAND = { type: 'cmd', value: 0 };
const STATE = 123;
const STORE = { getState() { return STATE; } };

describe(applyDispatchMiddleware.name, () => {
  let dispatcher: MessageBus<typeof COMMAND>;

  it('should decorate dispatcher with middleware', async () => {
    expect.assertions(6);

    const Dispatcher = applyDispatchMiddleware(
      SimpleMessageBus, STORE,
      (store) => (dispatch) => (command, options) => {
        expect(store.getState()).toBe(STATE);
        expect(command).toEqual(COMMAND);
        return dispatch({ ...COMMAND, value: 1 }, options);
      },
      (store) => (dispatch) => (command, options) => {
        expect(store.getState()).toBe(STATE);
        expect(command).toEqual({ ...COMMAND, value: 1 });
        return dispatch({ ...COMMAND, value: 2 }, options);
      },
    );

    dispatcher = new Dispatcher();
    const consumer = jest.fn(() => undefined);
    dispatcher.subscribe(consumer, { topic: TOPIC });
    dispatcher.dispatch(COMMAND, { topic: TOPIC });

    await delay();

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer).toHaveBeenCalledWith({ ...COMMAND, value: 2 }, { topic: TOPIC });
  });
});

describe(applySubscribeMiddleware.name, () => {
  let subscription: MessageBus<typeof COMMAND>;

  it('should decorate subscription with middleware', async () => {
    expect.assertions(6);

    const Subscription = applySubscribeMiddleware(
      SimpleMessageBus, STORE,
      (store) => (subscribe) => (consumer, options) => {
        expect(store.getState()).toBe(STATE);
        return subscribe((command, options) => {
          expect(command).toEqual(COMMAND);
          return consumer({ ...COMMAND, value: 1 }, options);
        }, options);
      },
      (store) => (subscribe) => (consumer, options) => {
        expect(store.getState()).toBe(STATE);
        return subscribe((command, options) => {
          expect(command).toEqual({ ...COMMAND, value: 1 });
          return consumer({ ...COMMAND, value: 2 }, options);
        }, options);
      },
    );

    subscription = new Subscription();
    const consumer = jest.fn<MessageHandler<typeof COMMAND>>();
    subscription.subscribe(consumer, { topic: TOPIC });
    subscription.dispatch(COMMAND, { topic: TOPIC });

    await delay();

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer).toHaveBeenCalledWith({ ...COMMAND, value: 2 }, { topic: TOPIC });
  });
});
