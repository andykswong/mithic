import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MessageValidationError } from '@mithic/messaging';
import { RedisClientType, commandOptions } from '@redis/client';
import { createMockRedisClient } from './mocks.js';
import { RedisMessageBus } from '../bus.js';

const TOPIC = 'testTopic';
const TOPIC2 = 'testTopic2';
const DATA = 'data';
const DATA2 = 'data2';
const OPTIONS = { signal: AbortSignal.timeout(100) };

describe(RedisMessageBus.name, () => {
  let bus: RedisMessageBus;
  let mockRedis: RedisClientType;

  beforeEach(async () => {
    mockRedis = createMockRedisClient();
    bus = new RedisMessageBus(mockRedis);
    await bus.start();
  });

  afterEach(async () => {
    await bus.close();
  });

  it('should be started', () => {
    expect(bus.started).toBe(true);
  });

  describe('close', () => {
    it('should set started to false', async () => {
      await bus.close();
      expect(bus.started).toBe(false);
    });
  });

  describe('dispatch', () => {
    it('should dispatch to underlying pubsub', async () => {
      await bus.dispatch(DATA, { topic: TOPIC, ...OPTIONS });
      expect(mockRedis.publish).toHaveBeenCalledWith(commandOptions(OPTIONS), TOPIC, DATA);
    });

    it('should use defaultTopic if topic is not specified', async () => {
      await bus.dispatch(DATA, OPTIONS);
      expect(mockRedis.publish).toHaveBeenCalledWith(commandOptions(OPTIONS), bus.defaultTopic, DATA);
    });
  });

  describe('subscribe', () => {
    it('should subscribe to underlying pubsub', async () => {
      const validator = jest.fn(() => undefined as MessageValidationError | undefined);
      const handler = jest.fn(() => undefined);

      await bus.subscribe(handler, { topic: TOPIC, validator });
      expect(mockRedis.subscribe).toHaveBeenCalledWith(TOPIC, expect.any(Function), void 0);

      const listener = jest.mocked(mockRedis.subscribe).mock.calls[0][1];
      validator
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(new MessageValidationError());

      await listener(DATA, TOPIC);
      expect(validator).toHaveBeenCalledWith(DATA, { topic: TOPIC });
      expect(handler).toHaveBeenCalledWith(DATA, { topic: TOPIC });

      await listener(DATA2, TOPIC);
      expect(validator).toHaveBeenCalledWith(DATA2, { topic: TOPIC });
      expect(handler).not.toHaveBeenCalledWith(DATA2, { topic: TOPIC });
    });

    it('should return a function to unsubscribe from underlying pubsub', async () => {
      const unsubscribe = await bus.subscribe(jest.fn(() => undefined), { topic: TOPIC });
      const listener = jest.mocked(mockRedis.subscribe).mock.calls[0][1];
      await unsubscribe();
      expect(mockRedis.unsubscribe).toHaveBeenCalledWith(TOPIC, listener, undefined);
    });
  });

  describe('topics', () => {
    it('should return available topics from underlying pubsub', async () => {
      const topics = [TOPIC, TOPIC2];
      jest.mocked(mockRedis.pubSubChannels).mockReturnValue(Promise.resolve(topics));

      await expect(bus.topics(OPTIONS)).resolves.toEqual(topics);
      expect(mockRedis.pubSubChannels).toHaveBeenCalledWith(OPTIONS);
    });
  });
});
