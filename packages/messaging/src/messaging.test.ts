import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { IncomingHandlerFQN, Messaging, type MessagingGuest } from './index.ts';
import { type MockMessagingService, createMockMessagingService } from './test/mocks.ts';

const TOPIC = 'topic';

describe('Messaging', () => {
  let service: MockMessagingService;

  beforeEach(() => {
    Messaging.service = service = createMockMessagingService();
  });

  describe('subscribe', () => {
    it('should subscribe guest module to service', () => {
      const guest = {
        [IncomingHandlerFQN]: {
          handle: mock.fn(),
        }
      } satisfies MessagingGuest;

      Messaging.subscribe([TOPIC], guest);
      assert.strictEqual(service.subscribe.mock.callCount(), 1);
      assert.deepStrictEqual(service.subscribe.mock.calls[0].arguments, [[TOPIC], guest[IncomingHandlerFQN]]);
    });
  });
});
