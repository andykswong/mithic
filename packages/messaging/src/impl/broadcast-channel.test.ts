import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { delay, dispose } from '@mithic/commons';
import { deepStrictContainEqual } from '../test/assert.ts';
import { MessageMetadata, type Message, type PeerId } from '../types.ts';
import { BroadcastChannelMessagingService } from './index.ts';

const MESSAGE = 'message' as const;
const KEEPALIVE = 'keepalive' as const;
const CHANNEL = 'test-channel';
const PEER_ID = 'peer' as PeerId;
const OTHER_PEER_ID = 'peer2' as PeerId;
const INACTIVE_PEER_ID = 'peer3' as PeerId;
const KEEPALIVE_MS = 50;
const TOPIC = 'test-topic';
const TOPIC2 = 'topic2';
const DATA = new Uint8Array([9, 8, 7, 6, 5]);

describe('BroadcastChannelMessagingService', () => {
  let service: BroadcastChannelMessagingService;
  let subscriber: BroadcastChannel;
  let now = 0;

  beforeEach(() => {
    now = 0;
    service = new BroadcastChannelMessagingService({
      peerId: PEER_ID,
      channel: CHANNEL,
      keepaliveMs: KEEPALIVE_MS,
      now: () => now,
    });
    subscriber = new BroadcastChannel(CHANNEL);
  });

  afterEach(() => {
    dispose(service);
    subscriber.close();
  });

  it('should emit keepalive messages', async () => {
    const receivedMessages: BroadcastChannelMessage[] = [];

    subscriber.addEventListener('message', (event) => {
      receivedMessages.push(event.data);
    });

    service.subscribe([TOPIC]);

    await delay(100); // Wait for keepalive message to be delivered

    deepStrictContainEqual(receivedMessages, {
      type: 'keepalive',
      topics: [TOPIC],
      from: PEER_ID,
    });
  });

  describe('send', () => {
    it('should dispatch to channel', async () => {
      const receivedMessages: BroadcastChannelMessage[] = [];

      subscriber.addEventListener('message', (event) => {
        receivedMessages.push(event.data);
      });

      const message: Message = {
        topic: TOPIC,
        data: DATA,
        metadata: [['key1', 'value1']]
      };

      service.subscribe([TOPIC]);
      service.send(message);

      await delay(100); // Wait for the message to be delivered

      deepStrictContainEqual(receivedMessages, {
        type: MESSAGE,
        from: PEER_ID,
        msg: message,
      });
    });
  });

  describe('reply', () => {
    it('should send reply message to channel', async () => {
      const receivedMessages: BroadcastChannelMessage[] = [];

      subscriber.addEventListener('message', (event) => {
        receivedMessages.push(event.data);
      });

      const cid = 'test_id123';
      const message: Message = {
        topic: TOPIC,
        data: DATA,
        metadata: [[MessageMetadata.RequestId, cid], [MessageMetadata.ReplyTopic, TOPIC2], [MessageMetadata.From, OTHER_PEER_ID]]
      };
      const reply: Message = {
        topic: TOPIC,
        data: new Uint8Array([1, 2, 3, 5, 6]),
        metadata: [[MessageMetadata.CorrelationId, cid], [MessageMetadata.From, PEER_ID]]
      };

      service.reply(message, reply);

      await delay(100); // Wait for the message to be delivered

      deepStrictContainEqual(receivedMessages, {
        type: MESSAGE,
        from: PEER_ID,
        msg: { ...reply, topic: TOPIC2 },
      });
    });
  });

  describe('request', () => {
    it('should send request and receive replies', async () => {
      const receivedMessages: BroadcastChannelMessage[] = [];

      subscriber.addEventListener('message', (event) => {
        receivedMessages.push(event.data);
      });

      const cid = 'test_id123';
      const message: Message = {
        topic: TOPIC,
        data: DATA,
        metadata: [[MessageMetadata.RequestId, cid], [MessageMetadata.ReplyTopic, TOPIC2], [MessageMetadata.From, PEER_ID]]
      };
      const reply: Message = {
        topic: TOPIC,
        data: new Uint8Array([3, 5, 7]),
        metadata: [[MessageMetadata.CorrelationId, cid], [MessageMetadata.From, PEER_ID]]
      };

      const promise = service.request(message, { timeoutMs: 200 });
      await delay(100);
      service.reply(message, reply);

      await delay(100);
      assert.deepStrictEqual(await promise, [{ ...reply, topic: TOPIC2 }]);
      deepStrictContainEqual(receivedMessages, {
        type: MESSAGE,
        from: PEER_ID,
        msg: message,
      });
    });

    it('should return empty list if no reply', async () => {
      const cid = 'test_id123';
      const message: Message = {
        topic: TOPIC,
        data: DATA,
        metadata: [[MessageMetadata.CorrelationId, cid], [MessageMetadata.From, PEER_ID]]
      };
      assert.deepStrictEqual(await service.request(message, { timeoutMs: 0 }), []);
    });
  });

  describe('subscribe', () => {
    it('should start forwarding messages to handler', async () => {
      const receivedMessages: Message[] = [];
      const handler = mock.fn((msg: Message) => { receivedMessages.push(msg); });
      const message: Message = {
        topic: TOPIC,
        data: DATA,
        metadata: []
      };

      service.onmessage = handler;
      service.subscribe([TOPIC]);

      subscriber.postMessage({
        type: MESSAGE,
        from: OTHER_PEER_ID,
        msg: message,
      });

      await delay(100); // Wait for the message to be delivered

      deepStrictContainEqual(receivedMessages, {
        ...message,
        metadata: [[MessageMetadata.From, OTHER_PEER_ID]],
      });
    });

    it('should stop forwarding messages from unsubscribed topics', async () => {
      const receivedMessages: Message[] = [];
      const handler = mock.fn((msg: Message) => { receivedMessages.push(msg); });
      const message: Message = {
        topic: TOPIC,
        data: DATA,
        metadata: []
      };

      service.onmessage = handler;
      service.subscribe([TOPIC, TOPIC2]);
      service.subscribe([TOPIC2]);

      subscriber.postMessage({
        type: MESSAGE,
        from: OTHER_PEER_ID,
        msg: message,
      });

      await delay(100); // Wait for the message to be delivered

      assert.deepStrictEqual(receivedMessages, []);
    });

    it('should ignore messages from unsubscribed topics', async () => {
      const receivedMessages: Message[] = [];
      const handler = mock.fn((msg: Message) => { receivedMessages.push(msg); });

      service.onmessage = handler;
      service.subscribe([TOPIC]);
      subscriber.postMessage({
        type: MESSAGE,
        from: OTHER_PEER_ID,
        data: {
          topic: 'topic2',
          data: DATA,
          metadata: []
        },
      });

      await delay(100); // Wait for the message to be delivered

      assert.deepStrictEqual(receivedMessages, []);
    });

    it('should update peer lastSeen on keepalive message', async () => {
      service.subscribe([TOPIC]);

      for (let i = 0; i < 2; ++i, now += 1000) {
        subscriber.postMessage({
          type: KEEPALIVE,
          topics: [TOPIC],
          from: OTHER_PEER_ID,
        });

        await delay(100); // Wait for the message to be delivered

        assert.deepStrictEqual(service['topicSubscribers'].get(TOPIC)?.get(`${OTHER_PEER_ID}`), [OTHER_PEER_ID, now]);
      }
    });

    it('should drop malformed message', async () => {
      const receivedMessages: unknown[] = [];
      const handler = mock.fn((event) => {
        receivedMessages.push(event);
      });

      service.onmessage = handler;
      service.subscribe([TOPIC]);
      subscriber.postMessage('rubbish');

      await delay(100); // Wait for the message to be delivered

      assert.strictEqual(receivedMessages.length, 0);
    });
  });

  describe('subscribers', () => {
    it('should return topic subscribers', () => {
      service['topicSubscribers'].set(TOPIC, new Map([
        [`${OTHER_PEER_ID}`, [OTHER_PEER_ID, now]]
      ]));

      assert.deepStrictEqual([...service.subscribers(TOPIC)], [PEER_ID, OTHER_PEER_ID]);
    });

    it('should clean up inactive topic subscribers', () => {
      const origTime = now;
      now += KEEPALIVE_MS * 1000;
      service['topicSubscribers'].set(TOPIC, new Map([
        [`${OTHER_PEER_ID}`, [OTHER_PEER_ID, now]],
        [`${INACTIVE_PEER_ID}`, [INACTIVE_PEER_ID, origTime]]
      ]));

      assert.deepStrictEqual([...service.subscribers(TOPIC)], [PEER_ID, OTHER_PEER_ID]);
      assert.strictEqual(service['topicSubscribers'].get(TOPIC)?.has(`${INACTIVE_PEER_ID}`), false);
    });
  });

  describe('topics', () => {
    it('should return subscribed topics', () => {
      assert.deepStrictEqual([...service.topics()], []);
      service.subscribe([TOPIC]);
      assert.deepStrictEqual([...service.topics()], [TOPIC]);
    });
  });
});

type BroadcastChannelMessage = {
  type: typeof MESSAGE | typeof KEEPALIVE,
  from: PeerId,
  topics?: string[],
  msg?: Message,
};
