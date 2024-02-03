import { beforeEach, describe, expect, it } from '@jest/globals';
import { delay } from '@mithic/commons';
import { SimpleMessageBus } from '@mithic/messaging';
import { MessageTransformer } from '../transformer.ts';

const IN_COMMAND = { type: 'rawEvent' };
const OUT_EVENT = { type: 'transformedEvent' };

describe(MessageTransformer.name, () => {
  let subscription: SimpleMessageBus<{ type: string }>;
  let dispatcher: SimpleMessageBus<{ type: string }>;

  beforeEach(() => {
    subscription = new SimpleMessageBus();
    dispatcher = new SimpleMessageBus();
  });

  it('should transform incoming message', async () => {
    let inCommand, outEvent;

    const translator = new MessageTransformer(
      subscription,
      dispatcher,
      (msg) => {
        inCommand = msg;
        return OUT_EVENT;
      }
    );
    await translator.start();
    dispatcher.subscribe((msg) => { outEvent = msg; });
    subscription.dispatch(IN_COMMAND);

    await delay(); // wait for event to be consumed

    expect(inCommand).toEqual(IN_COMMAND);
    expect(outEvent).toEqual(OUT_EVENT)
  });

  it('should not dispatch message if handler returns undefined', async () => {
    let inCommand, outEvent;

    const translator = new MessageTransformer(
      subscription,
      dispatcher,
      (msg) => {
        inCommand = msg;
        return undefined;
      }
    );
    await translator.start();
    dispatcher.subscribe((msg) => { outEvent = msg || true; });
    subscription.dispatch(IN_COMMAND);

    await delay(); // wait for event to be consumed

    expect(inCommand).toEqual(IN_COMMAND);
    expect(outEvent).toBeUndefined();
  });
});
