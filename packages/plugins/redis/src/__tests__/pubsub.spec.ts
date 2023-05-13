import { jest } from '@jest/globals';
import { RedisClientType, commandOptions } from '@redis/client';
import { createMockRedisClient } from '../__tests__/mocks.js';
import { RedisPubSub } from '../pubsub.js';
import { MessageHandler, MessageValidator, MessageValidatorResult, PubSubMessage } from '@mithic/messaging';

const TOPIC = 'testTopic';
const TOPIC2 = 'testTopic2';
const DATA = 'data';
const DATA2 = 'data2';
const OPTIONS = { signal: AbortSignal.timeout(100) };

describe(RedisPubSub.name, () => {
  let pubsub: RedisPubSub;
  let mockRedis: RedisClientType;

  beforeEach(async () => {
    mockRedis = createMockRedisClient();
    pubsub = new RedisPubSub(mockRedis);
    await pubsub.start();
    expect(pubsub.started).toBe(true);
  });

  afterEach(async () => {
    await pubsub.close();
    expect(pubsub.started).toBe(false);
  });

  describe('publish', () => {
    it('should publish to underlying pubsub', async () => {
      await pubsub.publish(TOPIC, DATA, OPTIONS);
      expect(mockRedis.publish).toHaveBeenCalledWith(commandOptions(OPTIONS), TOPIC, DATA);
    });
  });

  describe('subscribe', () => {
    it('should subscribe to underlying pubsub', async () => {
      const validator = jest.fn<MessageValidator<PubSubMessage<string>>>();
      const handler = jest.fn<MessageHandler<PubSubMessage<string>>>();

      pubsub.subscribe(TOPIC, handler, { validator });
      expect(mockRedis.subscribe).toHaveBeenCalledWith(TOPIC, expect.any(Function), void 0);

      const listener = jest.mocked(mockRedis.subscribe).mock.calls[0][1];
      validator
        .mockReturnValueOnce(Promise.resolve(MessageValidatorResult.Accept))
        .mockReturnValueOnce(Promise.resolve(MessageValidatorResult.Reject));

      await listener(DATA, TOPIC);
      expect(validator).toHaveBeenCalledWith({ topic: TOPIC, data: DATA });
      expect(handler).toHaveBeenCalledWith({ topic: TOPIC, data: DATA });

      await listener(DATA2, TOPIC);
      expect(validator).toHaveBeenCalledWith({ topic: TOPIC, data: DATA2 });
      expect(handler).not.toHaveBeenCalledWith({ topic: TOPIC, data: DATA2 });
    });
  });

  describe('unsubscribe', () => {
    it('should unsubscribe from underlying pubsub', () => {
      pubsub.unsubscribe(TOPIC);
      expect(mockRedis.unsubscribe).toHaveBeenCalledWith(TOPIC);
    });
  });

  describe('topics', () => {
    it('should return available topics from underlying pubsub', async () => {
      const topics = [TOPIC, TOPIC2];
      jest.mocked(mockRedis.pubSubChannels).mockReturnValue(Promise.resolve(topics));

      await expect(pubsub.topics(OPTIONS)).resolves.toEqual(topics);
      expect(mockRedis.pubSubChannels).toHaveBeenCalledWith(OPTIONS);
    });
  });
});
