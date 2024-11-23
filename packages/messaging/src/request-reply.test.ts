import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type Message, MessageMetadata, Messaging, RoutingMessagingService, StringMatcher } from './index.ts';
import { reply, request } from './request-reply.ts';
import { createMockMessagingService, type MockMessagingService } from './test/mocks.ts';

const TOPIC = 'topic';
const TOPIC2 = 'topic2';
const CORRELATION_ID = 'cid';
const REQUEST: Message = { topic: TOPIC, metadata: [[MessageMetadata.RequestId, CORRELATION_ID], [MessageMetadata.ReplyTopic, TOPIC2]], data: new Uint8Array([1, 2, 3]) };
const REPLY: Message = { topic: TOPIC2, metadata: [[MessageMetadata.CorrelationId, CORRELATION_ID]], data: new Uint8Array([4]) };

describe('requestReply', () => {
  let service: MockMessagingService;

  beforeEach(() => {
    service = createMockMessagingService();
    Messaging.service = new RoutingMessagingService([[StringMatcher.matchAll(), service]]);
  });

  describe('reply', () => {
    it('should send reply message to topic', () => {
      reply(REQUEST, REPLY);
      assert.strictEqual(service.reply?.mock.callCount(), 1);
      assert.deepStrictEqual(service.reply?.mock.calls[0].arguments, [REQUEST, REPLY]);
    });
  });

  describe('request', () => {
    it('should send request message to topic and wait for replies', () => {
      service.request?.mock.mockImplementationOnce(() => [REPLY]);
      const options = { expectedReplies: 2, timeoutMs: 1000 };
      const replies = request(REQUEST, options);

      assert.deepStrictEqual(replies, [REPLY]);
      assert.strictEqual(service.request?.mock.callCount(), 1);
      assert.deepStrictEqual(service.request?.mock.calls[0].arguments, [REQUEST, options]);
    });
  });
});
