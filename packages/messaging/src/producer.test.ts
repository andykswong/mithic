import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Messaging } from './index.ts';
import { send } from './producer.ts';
import { type MockMessagingService, createMessage, createMockMessagingService } from './test/mocks.ts';

const TOPIC = 'topic';
const MSG = createMessage();

describe('producer', () => {
  let service: MockMessagingService;

  beforeEach(() => {
    Messaging.service = service = createMockMessagingService();
  });

  describe('send', () => {
    it('should send message to topic', () => {
      send(TOPIC, MSG);
      assert.strictEqual(service.send.mock.callCount(), 1);
      assert.deepStrictEqual(service.send.mock.calls[0].arguments, [TOPIC, MSG]);
    });
  });
});
