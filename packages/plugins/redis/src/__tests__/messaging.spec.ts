import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { dispose } from '@mithic/commons';
import { MessageMetadata, type Message } from '@mithic/messaging';
import { type RedisClientType } from '@redis/client';
import { encode } from 'cbor-x/encode';
import { createMockRedisClient } from './mocks.ts';
import { RedisPubSubMessagingService } from '../messaging.ts';

const TOPIC = 'testTopic';
const TOPIC2 = 'topic2';
const CID = 'cid';
const MSG: Message = {
  topic: TOPIC,
  metadata: [[MessageMetadata.RequestId, CID], [MessageMetadata.ReplyTopic, TOPIC2]],
  data: new Uint8Array([1])
};
const REPLY: Message = { topic: TOPIC2, metadata: [[MessageMetadata.CorrelationId, CID]], data: new Uint8Array([2]) };

describe(RedisPubSubMessagingService.name, () => {
  let service: RedisPubSubMessagingService;
  let mockRedis: RedisClientType;

  beforeEach(async () => {
    mockRedis = createMockRedisClient();
    service = new RedisPubSubMessagingService({ client: mockRedis });
    await service.start();
  });

  afterEach(() => {
    dispose(service);
  });

  it('should be started', () => {
    expect(service.started).toBe(true);
  });

  describe('dispose', () => {
    it('should close connection', async () => {
      await dispose(service);
      expect(service.started).toBe(false);
    });
  });

  describe('send', () => {
    it('should publish message to redis', async () => {
      await service.send(MSG);
      expect(mockRedis.publish).toHaveBeenCalledWith(TOPIC, encode(MSG));
    });
  });

  describe('request', () => {
    it('should publish reply message to redis', async () => {
      const replies = service.request(MSG);
      service['requestReplyHelper'].accept(REPLY);
      await expect(replies).resolves.toEqual([REPLY]);
      expect(mockRedis.publish).toHaveBeenCalledWith(TOPIC, encode(MSG));
    });
  });

  describe('reply', () => {
    it('should publish reply message to redis', async () => {
      await service.reply(MSG, REPLY);
      expect(mockRedis.publish).toHaveBeenCalledWith(TOPIC2, encode(REPLY));
    });
  });

  describe('subscribe', () => {
    it('should start listening to Deno message queue', async () => {
      const messages: Message[] = [];
      service.onmessage = (msg) => { messages.push(msg); };
      await service.subscribe([TOPIC]);

      expect(mockRedis.subscribe).toHaveBeenCalledWith(TOPIC, expect.any(Function), true);
      await jest.mocked(mockRedis.subscribe).mock.calls[0][1](encode(MSG), Buffer.from([]));
      expect(messages).toEqual([MSG]);
    });

    it('should call unsubscribe to removed topics', async () => {
      await service.subscribe([TOPIC, TOPIC2]);
      await service.subscribe([TOPIC]);
      expect(mockRedis.unsubscribe).toHaveBeenCalledWith(TOPIC2, expect.any(Function), true);
    });
  });

  describe('topics', () => {
    it('should return available topics from underlying pubsub', async () => {
      const topics = [TOPIC, TOPIC2];
      (mockRedis.pubSubChannels as jest.Mocked<typeof mockRedis['pubSubChannels']>)
        .mockReturnValue(Promise.resolve(topics));
      expect(await service.topics()).toEqual(topics);
    });
  });
});
