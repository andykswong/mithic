import { jest } from '@jest/globals';
import { delay } from '@mithic/commons';
import { MessageBus, MessageConsumer } from '../../bus.js';
import { SimpleMessageBus } from '../../bus/index.js';
import { applyMiddleware } from '../middleware.js';

const COMMAND = { type: 'cmd', value: 0 };
const STATE = 123;
const STORE = { getState() { return STATE; } };

describe(applyMiddleware.name, () => {
  let dispatcher: MessageBus<typeof COMMAND>;

  it('should decorate dispatcher with middleware', async () => {
    expect.assertions(6);

    const Dispatcher = applyMiddleware(
      SimpleMessageBus, STORE,
      (store) => (dispatch) => (command) => {
        expect(store.getState()).toBe(STATE);
        expect(command).toEqual(COMMAND);
        return dispatch({ ...COMMAND, value: 1 });
      },
      (store) => (dispatch) => (command) => {
        expect(store.getState()).toBe(STATE);
        expect(command).toEqual({ ...COMMAND, value: 1 });
        return dispatch({ ...COMMAND, value: 2 });
      },
    );

    dispatcher = new Dispatcher();
    const consumer = jest.fn<MessageConsumer<typeof COMMAND>>();
    dispatcher.subscribe(consumer);
    dispatcher.dispatch(COMMAND);

    await delay();

    expect(consumer).toHaveBeenCalledTimes(1);
    expect(consumer).toHaveBeenCalledWith({ ...COMMAND, value: 2 });
  });
});
