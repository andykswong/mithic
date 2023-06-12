import { jest } from '@jest/globals';
import { MessageHandler, PubSubMessage } from '@mithic/messaging';
import { MockPubSub } from '../../__tests__/mocks.js';
import { PubSubMessageBus } from '../pubsub.js';

const TOPIC = 'topic';
const EVENT = new Uint8Array([65, 66, 67]);
const MSG: PubSubMessage<Uint8Array> = { topic: TOPIC, data: EVENT };

describe(PubSubMessageBus.name, () => {
  let pubsub: MockPubSub;
  let eventBus: PubSubMessageBus<Uint8Array>;

  beforeEach(() => {
    pubsub = new MockPubSub();
    eventBus = new PubSubMessageBus(pubsub, TOPIC);
  });

  it('should dispatch message using pubsub', async () => {
    const publishSpy = jest.spyOn(pubsub, 'publish');
    const options = {};

    await eventBus.dispatch(EVENT, options);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith(TOPIC, EVENT, options);
  });

  it('should allow multiple subscribers to a topic', async () => {
    const mockHandler1 = jest.fn<MessageHandler<Uint8Array>>();
    const mockHandler2 = jest.fn<MessageHandler<Uint8Array>>();
    const subscribeSpy = jest.spyOn(pubsub, 'subscribe');
    const options = {};

    await eventBus.subscribe(mockHandler1, options);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledWith(TOPIC, eventBus['consumer'], options);
    expect(eventBus['consumers']).toEqual([mockHandler1]);

    await eventBus.subscribe(mockHandler2);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(eventBus['consumers']).toEqual([mockHandler1, mockHandler2]);

    await eventBus['consumer'](MSG);
    expect(mockHandler1).toHaveBeenCalledTimes(1);
    expect(mockHandler1).toHaveBeenCalledWith(EVENT);
    expect(mockHandler2).toHaveBeenCalledTimes(1);
    expect(mockHandler2).toHaveBeenCalledWith(EVENT);

  });

  it('should be able to unsubscribe a specific handler from a topic', async () => {
    const mockHandler1 = jest.fn<MessageHandler<Uint8Array>>();
    const mockHandler2 = jest.fn<MessageHandler<Uint8Array>>();

    const unsubscribe1 = await eventBus.subscribe(mockHandler1);
    await eventBus.subscribe(mockHandler2);
    expect(eventBus['consumers']).toEqual([mockHandler1, mockHandler2]);

    await unsubscribe1();
    expect(eventBus['consumers']).toEqual([mockHandler2]);
  });
  
  it('should do nothing when trying to unsubscribe a non-existing handler', async () => {
    const mockHandler1 = jest.fn<MessageHandler<Uint8Array>>();
    const mockHandler2 = jest.fn<MessageHandler<Uint8Array>>();

    await eventBus.subscribe(mockHandler1);
    expect(eventBus['consumers']).toEqual([mockHandler1]);

    await eventBus.unsubscribe(mockHandler2);
    expect(eventBus['consumers']).toEqual([mockHandler1]);
  });

  it('should unsubscribe from pubsub when there is no more handler', async () => {
    const mockHandler1 = jest.fn<MessageHandler<Uint8Array>>();
    const mockHandler2 = jest.fn<MessageHandler<Uint8Array>>();
    const unsubscribeSpy = jest.spyOn(pubsub, 'unsubscribe');
    const options = {};

    const unsubscribe1 = await eventBus.subscribe(mockHandler1);
    const unsubscribe2 = await eventBus.subscribe(mockHandler2);
    expect(eventBus['consumers']).toEqual([mockHandler1, mockHandler2]);

    await unsubscribe1();
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    await unsubscribe2(options);
    expect(eventBus['consumers']).toEqual([]);
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    expect(unsubscribeSpy).toHaveBeenCalledWith(TOPIC, options);
  });
});
