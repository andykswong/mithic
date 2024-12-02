import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { StringMatcher } from '@mithic/commons';
import { Messaging, type PeerId, RoutingMessagingService } from './index.ts';
import { listSubscribers } from './presence.ts';
import { createMockMessagingService, type MockMessagingService } from './test/mocks.ts';

const TOPIC = 'topic';
const PEER = 'peer' as PeerId;
const PEER2 = 'peer2' as PeerId;

describe('presence', () => {
  let service: MockMessagingService;

  beforeEach(() => {
    service = createMockMessagingService();
    Messaging.service = new RoutingMessagingService([[StringMatcher.matchAll(), service]]);
  });

  describe('listSubscribers', () => {
    it('should return subscribers to topic', () => {
      service.listSubscribers?.mock.mockImplementationOnce(() => [PEER, PEER2]);
      assert.deepStrictEqual(listSubscribers(TOPIC), [PEER, PEER2]);
      assert.strictEqual(service.listSubscribers?.mock.callCount(), 1);
      assert.deepStrictEqual(service.listSubscribers?.mock.calls[0].arguments, [TOPIC]);
    });
  });
});
