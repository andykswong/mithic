import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { delay, dispose } from '@mithic/commons';
import { deepStrictContainEqual } from './test/assert.ts';
import { runWorker } from './test/worker.ts';
import { BroadcastChannelMessagingService, MessageMetadata, type Message, Messaging, type PeerId } from './index.ts';
import { reply, request } from './request-reply.ts';

const TOPIC = 'topic';
const TOPIC2 = 'topic2';
const PEER = 'peer' as PeerId;
const PEER2 = 'peer2' as PeerId;
const CORRELATION_ID = 'cid';
const REQUEST: Message = { topic: TOPIC, metadata: [[MessageMetadata.RequestId, CORRELATION_ID], [MessageMetadata.ReplyTopic, TOPIC2]], data: new Uint8Array([1, 2, 3]) };
const REPLY: Message = { topic: TOPIC2, metadata: [[MessageMetadata.CorrelationId, CORRELATION_ID]], data: new Uint8Array([4]) };

describe('requestReply', () => {
  let worker: Worker;
  let service: BroadcastChannelMessagingService;

  beforeEach(async () => {
    const channel = `channel${(Math.random() * 10000) | 0}`;
    service = new BroadcastChannelMessagingService({ channel, peerId: PEER2 });
    [worker, Messaging.provider] = runWorker({ channel, peerId: PEER, peerId2: PEER2, autoReply: REPLY, topics: [TOPIC, TOPIC2] });
  });

  afterEach(async () => {
    dispose(service);
    await worker?.terminate();
  });

  describe('reply', () => {
    it('should send reply message to topic', async () => {
      const messages: Message[] = [];
      service.onmessage = (msg) => { messages.push(msg); }
      service.subscribe([TOPIC, TOPIC2]);
      reply({ ...REQUEST, metadata: [...REQUEST.metadata, [MessageMetadata.From, PEER2]] }, REPLY);
      await delay(100);
      assert.deepStrictEqual(messages, [{ ...REPLY, metadata: [...REPLY.metadata, [MessageMetadata.From, PEER]] }]);
    });
  });

  describe('request', () => {
    it('should send request message to topic and wait for replies', async () => {
      const messages: Message[] = [];
      service.onmessage = (msg) => { messages.push(msg) };
      service.subscribe([TOPIC, TOPIC2]);
      const replies = request(REQUEST, { expectedReplies: 2, timeoutMs: 1000 });
      await delay(100);
      assert.deepStrictEqual(replies, [{ ...REPLY, metadata: [...REPLY.metadata, [MessageMetadata.From, PEER2]] }]);
      deepStrictContainEqual(messages, { ...REQUEST, metadata: [...REQUEST.metadata, [MessageMetadata.From, PEER]] });
    });
  });
});
