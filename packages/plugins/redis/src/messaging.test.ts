import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, type Mock } from 'node:test';
import { dispose } from '@mithic/commons';
import { Message, MessageMetadata, type MessageHandler } from '@mithic/messaging';
import type { RedisClientType } from '@redis/client';
import { encode } from 'cbor-x/encode';
import { assertCalledWith, assertCalledWithArg, getCallArg } from './test/assert.ts';
import { createMockRedisClient } from './test/mocks.js';
import { RedisPubSubMessagingService } from './index.ts';

const TOPIC = 'testTopic';
const TOPIC2 = 'topic2';
const CID = 'cid';
const MSG = Message.from({
  metadata: [[MessageMetadata.RequestId, CID], [MessageMetadata.ReplyTopic, TOPIC2]],
  data: new Uint8Array([1])
});
const MSG_RECEIVED = Message.from({ ...MSG.toRecord(), topic: TOPIC });
const REPLY = Message.from({ metadata: [[MessageMetadata.CorrelationId, CID]], data: new Uint8Array([2]) });
const REPLY_SENT = Message.from({ ...REPLY.toRecord(), topic: TOPIC2 });

describe('RedisPubSubMessagingService', () => {
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
    assert.strictEqual(service.started, true);
  });

  describe('dispose', () => {
    it('should close connection', async () => {
      await dispose(service);
      assert.strictEqual(service.started, false);
    });
  });

  describe('send', () => {
    it('should publish message to redis', async () => {
      await service.send(TOPIC, MSG);
      assertCalledWith(mockRedis.publish, 0, TOPIC, Buffer.from(encode(MSG_RECEIVED.toRecord())));
    });
  });

  describe('request', () => {
    it('should publish reply message to redis', async () => {
      const replies = service.request(TOPIC, MSG);
      assert.strictEqual(service['requestReply'].accept(REPLY_SENT), true);
      assert.deepStrictEqual(await replies, [REPLY_SENT]);
      assertCalledWith(mockRedis.publish, 0, TOPIC, encode(MSG_RECEIVED.toRecord()));
    });
  });

  describe('reply', () => {
    it('should publish reply message to redis', async () => {
      await service.reply(MSG, REPLY);
      assertCalledWith(mockRedis.publish, 0, TOPIC2, Buffer.from(encode(REPLY_SENT.toRecord())));
    });
  });

  describe('subscribe', () => {
    it('should start listening to Deno message queue', async () => {
      const messages: Message[] = [];
      const handler = { handle(msg) { messages.push(msg); } } satisfies MessageHandler;
      await service.subscribe([TOPIC], handler);

      assertCalledWithArg(mockRedis.subscribe, 0, 0, TOPIC);
      assertCalledWithArg(mockRedis.subscribe, 0, 2, true);
      await getCallArg(mockRedis.subscribe, 0, 1)(encode(MSG_RECEIVED.toRecord()), Buffer.from([]));
      assert.deepStrictEqual(messages, [MSG_RECEIVED]);
    });

    it('should call unsubscribe to removed topics', async () => {
      const handler = { handle() { } };
      await service.subscribe([TOPIC, TOPIC2], handler);
      await service.subscribe([TOPIC], handler);

      assertCalledWithArg(mockRedis.unsubscribe, 0, 0, TOPIC2);
      assertCalledWithArg(mockRedis.unsubscribe, 0, 2, true);
      assert(getCallArg(mockRedis.unsubscribe, 0, 1) instanceof Function);
    });
  });

  describe('topics', () => {
    it('should return available topics from underlying pubsub', async () => {
      const topics = [TOPIC, TOPIC2];
      (mockRedis.pubSubChannels as Mock<RedisClientType['pubSubChannels']>).mock
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(() => (Promise.resolve(topics) as any));
      assert.deepStrictEqual(await service.topics(), topics);
    });
  });
});
