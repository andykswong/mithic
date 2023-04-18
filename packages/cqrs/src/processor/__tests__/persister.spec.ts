import { jest } from '@jest/globals';
import { delay } from '@mithic/commons';
import { EventTransformer } from '../../event.js';
import { SimpleEventBus } from '../../event/index.js';
import { EventPersister, ObjectWriter } from '../persister.js';

const RAW_EVENT = { type: 'rawEvent' };
const TRANSFORMED_EVENT = { type: 'transformedEvent' };

describe(EventPersister.name, () => {
  let subscription: SimpleEventBus<{ type: string }>;
  let writer: MockObjectWriter<{ type: string }>;

  beforeEach(() => {
    subscription = new SimpleEventBus();
    writer = new MockObjectWriter();
  });

  it('should transform and persist incoming events', async () => {
    const transformer: jest.MockedFunction<EventTransformer<{ type: string }>> = jest.fn();
    transformer.mockReturnValue(Promise.resolve(TRANSFORMED_EVENT));

    const persister = new EventPersister(subscription, writer, transformer);
    await persister.start();
    subscription.dispatch(RAW_EVENT);

    await delay(); // wait for event to be consumed

    expect(writer.events).toEqual([TRANSFORMED_EVENT]);
  });
  
  it('should persist incoming events as is if transformer is not supplied', async () => {
    const persister = new EventPersister(subscription, writer);
    await persister.start();
    subscription.dispatch(RAW_EVENT);

    await delay(); // wait for event to be consumed

    expect(writer.events).toEqual([RAW_EVENT]);
  });

  it('should not call ObjectWriter if transformer returns undefined', async () => {
    const transformer: jest.MockedFunction<EventTransformer<{ type: string }>> = jest.fn();
    transformer.mockReturnValue(Promise.resolve(undefined));

    const persister = new EventPersister(subscription, writer, transformer);
    await persister.start();
    subscription.dispatch(RAW_EVENT);

    await delay(); // wait for event to be consumed

    expect(writer.events).toEqual([]);
  });
});

class MockObjectWriter<Event> implements ObjectWriter<Event, number> {
  public readonly events: Event[] = [];

  public async put(event: Event): Promise<number> {
    this.events.push(event);
    return this.events.length - 1;
  }
}
