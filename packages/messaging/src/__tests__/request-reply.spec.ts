import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { delay, dispose } from '@mithic/commons';
import { runWorker } from '#tests/worker';
import { BroadcastChannelMessagingService } from '../impl/index.ts';
import { Messaging } from '../provider/index.ts';
import { MessageMetadata, type Message, type PeerId } from '../types.ts';
import { reply, request } from '../request-reply.ts';

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
      expect(messages).toEqual([{ ...REPLY, metadata: [...REPLY.metadata, [MessageMetadata.From, PEER]] }]);
    });
  });

  describe('request', () => {
    it('should send request message to topic and wait for replies', async () => {
      const messages: Message[] = [];
      service.onmessage = (msg) => { messages.push(msg) };
      service.subscribe([TOPIC, TOPIC2]);
      const replies = request(REQUEST, { expectedReplies: 2, timeoutMs: 1000 });
      await delay(100);
      expect(replies).toEqual([{ ...REPLY, metadata: [...REPLY.metadata, [MessageMetadata.From, PEER2]] }]);
      expect(messages).toContainEqual({ ...REQUEST, metadata: [...REQUEST.metadata, [MessageMetadata.From, PEER]] });
    });
  });
});
