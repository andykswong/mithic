import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Startable, delay } from '@mithic/commons';
import { bindCommandHandler } from '../command.ts';
import { SimpleMessageBus } from '@mithic/messaging';

const TOPIC = 'message';
const IN_COMMAND = { type: 'cmd' };
const OUT_EVENT = { type: 'event' };
const STATE = 123;
const STORE = { getState() { return STATE; } };

describe(bindCommandHandler.name, () => {
  let commandBus: SimpleMessageBus<typeof IN_COMMAND>;
  let eventBus: SimpleMessageBus<typeof OUT_EVENT>;
  let handler: Startable;

  beforeEach(() => {
    commandBus = new SimpleMessageBus();
    eventBus = new SimpleMessageBus();
  });

  afterEach(async () => {
    await handler?.close();
  });

  it('should dispatch event from command', async () => {
    const eventConsumer = jest.fn(() => undefined);
    const commandHandler = async (state: number, command: typeof IN_COMMAND) => {
      if (state === STATE && command === IN_COMMAND) {
        return OUT_EVENT;
      }
    }
    handler = bindCommandHandler(commandBus, eventBus, commandHandler, STORE);
    await handler.start();
    eventBus.subscribe(eventConsumer);
    await commandBus.dispatch(IN_COMMAND, { topic: TOPIC});
    await delay();

    expect(eventConsumer).toHaveBeenCalledTimes(1);
    expect(eventConsumer).toHaveBeenCalledWith(OUT_EVENT, { topic: TOPIC});
  });
});
