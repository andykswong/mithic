import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { type Message, Messaging, RoutingMessagingService, StringMatcher } from './index.ts';
import { send } from './producer.ts';
import { type MockMessagingService, createMockMessagingService } from './test/mocks.ts';

const TOPIC = 'topic';
const MSG: Message = { topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) };

describe('producer', () => {
  let service: MockMessagingService;

  beforeEach(() => {
    service = createMockMessagingService();
    Messaging.service = new RoutingMessagingService([[StringMatcher.matchAll(), service]]);
  });

  describe('send', () => {
    it('should send message to topic', () => {
      send(MSG);
      assert.strictEqual(service.send.mock.callCount(), 1);
      assert.deepStrictEqual(service.send.mock.calls[0].arguments, [MSG]);
    });
  });
});
