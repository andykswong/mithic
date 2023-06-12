import { jest } from '@jest/globals';
import { delay } from '@mithic/commons';
import { MessageTransformer } from '../../bus.js';
import { SimpleMessageBus } from '../../bus/index.js';
import { MessagePersister, ObjectWriter } from '../persister.js';

const RAW_EVENT = { type: 'rawEvent' };
const TRANSFORMED_EVENT = { type: 'transformedEvent' };

describe(MessagePersister.name, () => {
  let subscription: SimpleMessageBus<{ type: string }>;
  let writer: MockObjectWriter<{ type: string }>;

  beforeEach(() => {
    subscription = new SimpleMessageBus();
    writer = new MockObjectWriter();
  });

  it('should transform and persist incoming messages', async () => {
    const transformer: jest.MockedFunction<MessageTransformer<{ type: string }>> = jest.fn();
    transformer.mockReturnValue(Promise.resolve(TRANSFORMED_EVENT));

    const persister = new MessagePersister(subscription, writer, transformer);
    await persister.start();
    subscription.dispatch(RAW_EVENT);

    await delay(); // wait for event to be consumed

    expect(writer.messages).toEqual([TRANSFORMED_EVENT]);
  });
  
  it('should persist incoming messages as is if transformer is not supplied', async () => {
    const persister = new MessagePersister(subscription, writer);
    await persister.start();
    subscription.dispatch(RAW_EVENT);

    await delay(); // wait for event to be consumed

    expect(writer.messages).toEqual([RAW_EVENT]);
  });

  it('should not call ObjectWriter if transformer returns undefined', async () => {
    const transformer: jest.MockedFunction<MessageTransformer<{ type: string }>> = jest.fn();
    transformer.mockReturnValue(Promise.resolve(undefined));

    const persister = new MessagePersister(subscription, writer, transformer);
    await persister.start();
    subscription.dispatch(RAW_EVENT);

    await delay(); // wait for event to be consumed

    expect(writer.messages).toEqual([]);
  });
});

class MockObjectWriter<Msg> implements ObjectWriter<Msg, number> {
  public readonly messages: Msg[] = [];

  public async put(event: Msg): Promise<number> {
    this.messages.push(event);
    return this.messages.length - 1;
  }
}
