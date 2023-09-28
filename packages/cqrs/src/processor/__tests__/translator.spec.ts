import { delay } from '@mithic/commons';
import { SimpleMessageBus } from '../../bus/index.js';
import { MessageTranslator } from '../translator.js';

const IN_COMMAND = { type: 'rawEvent' };
const OUT_EVENT = { type: 'transformedEvent' };

describe(MessageTranslator.name, () => {
  let subscription: SimpleMessageBus<{ type: string }>;
  let dispatcher: SimpleMessageBus<{ type: string }>;

  beforeEach(() => {
    subscription = new SimpleMessageBus();
    dispatcher = new SimpleMessageBus();
  });

  it('should transform incoming message', async () => {
    expect.assertions(2);

    const translator = new MessageTranslator(
      subscription,
      dispatcher,
      (msg) => {
        expect(msg).toEqual(IN_COMMAND);
        return OUT_EVENT;
      }
    );
    await translator.start();
    dispatcher.subscribe((msg) => expect(msg).toEqual(OUT_EVENT));
    subscription.dispatch(IN_COMMAND);

    await delay(); // wait for event to be consumed
  });

  it('should not dispatch message if handler returns undefined', async () => {
    expect.assertions(1);

    const translator = new MessageTranslator(
      subscription,
      dispatcher,
      (msg) => {
        expect(msg).toEqual(IN_COMMAND);
        return undefined;
      }
    );
    await translator.start();
    dispatcher.subscribe(() => expect(true).toBe(false));
    subscription.dispatch(IN_COMMAND);

    await delay(); // wait for event to be consumed
  });
});
