import { describe, expect, it, jest } from '@jest/globals';
import { delay } from '@mithic/commons';
import { MessageBus, MessageHandler } from '../../messaging.ts';
import { SimpleMessageBus } from '../../impl/simple.ts';
import { applyDispatchMiddleware, applySubscribeMiddleware } from '../middleware.ts';

const TOPIC = 'test';
const COMMAND = { type: 'cmd', value: 0 };
const STATE = 123;
const STORE = { getState() { return STATE; } };

describe(applyDispatchMiddleware.name, () => {
  let dispatcher: MessageBus<typeof COMMAND>;

  it('should decorate dispatcher with middleware', async () => {
    let middlewaresCalled = 0;

    const Dispatcher = applyDispatchMiddleware(
      SimpleMessageBus, STORE,
      (store) => (dispatch) => (command, options) => {
        expect(store.getState()).toBe(STATE);
        expect(command).toEqual(COMMAND);
        middlewaresCalled |= 1;
        return dispatch({ ...COMMAND, value: 1 }, options);
      },
      (store) => (dispatch) => (command, options) => {
        expect(store.getState()).toBe(STATE);
        expect(command).toEqual({ ...COMMAND, value: 1 });
        middlewaresCalled |= 2;
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
    expect(middlewaresCalled).toBe(3);
  });
});

describe(applySubscribeMiddleware.name, () => {
  let subscription: MessageBus<typeof COMMAND>;

  it('should decorate subscription with middleware', async () => {
    let middlewaresCalled = 0;

    const Subscription = applySubscribeMiddleware(
      SimpleMessageBus, STORE,
      (store) => (subscribe) => (consumer, options) => {
        expect(store.getState()).toBe(STATE);
        return subscribe((command, options) => {
          expect(command).toEqual(COMMAND);
          middlewaresCalled |= 1;
          return consumer({ ...COMMAND, value: 1 }, options);
        }, options);
      },
      (store) => (subscribe) => (consumer, options) => {
        expect(store.getState()).toBe(STATE);
        return subscribe((command, options) => {
          expect(command).toEqual({ ...COMMAND, value: 1 });
          middlewaresCalled |= 2;
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
    expect(middlewaresCalled).toBe(3);
  });
});
