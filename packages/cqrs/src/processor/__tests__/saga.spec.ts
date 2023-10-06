import { delay } from '@mithic/commons';
import { SagaProcessor } from '../saga.js';
import { SimpleMessageBus } from '@mithic/messaging';

const IN_COMMAND = { type: 'rawEvent' };
const OUT_EVENT1 = { type: 'transformedEvent', value: 1 };
const OUT_EVENT2 = { type: 'transformedEvent', value: 2 };

describe(SagaProcessor.name, () => {
  let subscription: SimpleMessageBus<{ type: string }>;
  let dispatcher: SimpleMessageBus<{ type: string }>;

  beforeEach(() => {
    subscription = new SimpleMessageBus();
    dispatcher = new SimpleMessageBus();
  });

  it('should handle incoming message and dispatch output messages from saga', async () => {
    const msgs: unknown[] = [];
    expect.assertions(2);

    const saga = new SagaProcessor(
      subscription,
      dispatcher,
      function* (msg) {
        expect(msg).toEqual(IN_COMMAND);
        yield OUT_EVENT1;
        yield OUT_EVENT2;
      }
    );
    await saga.start();
    dispatcher.subscribe((msg) => { msgs.push(msg); });
    subscription.dispatch(IN_COMMAND);

    await delay(); // wait for event to be consumed

    expect(msgs).toEqual([OUT_EVENT1, OUT_EVENT2]);
  });
});
