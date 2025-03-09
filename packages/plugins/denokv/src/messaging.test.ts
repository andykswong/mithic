import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Kv, openKv } from '@deno/kv';
import { delay, dispose } from '@mithic/commons';
import { Message, MessagingError, MessagingErrorType, type MessageHandler, type MessagingErrorPayload } from '@mithic/messaging';
import { DenoKvMessagingService } from './index.ts';

const TOPIC = 'testTopic';
const TOPIC2 = 'test2';
const INVALID_TOPIC_ERR = { tag: MessagingErrorType.PermissionDenied, val: 'invalid topic' } satisfies MessagingErrorPayload;
const MSG = Message.from({ metadata: [], data: new Uint8Array([1]) });
const MSG_RECEIVED = Message.from({ ...MSG.toRecord(), topic: TOPIC });
const DELAY = 100;
const KEYS_IF_UNDELIVERED = [['dlq', 1]];

describe('DenoKvMessagingService', () => {
  let service: DenoKvMessagingService;
  let kv: Kv;

  beforeEach(async () => {
    service = new DenoKvMessagingService({
      kv: async (topic) => {
        if (topic === TOPIC) {
          return (kv = await openKv());
        } else if (topic === TOPIC2) {
          return await openKv();
        }
        throw new MessagingError(INVALID_TOPIC_ERR);
      },
      delay: DELAY, keysIfUndelivered: () => KEYS_IF_UNDELIVERED
    });
  });

  afterEach(() => {
    dispose(service);
  });

  describe('send', () => {
    it('should enqueue message to Deno Kv', async () => {
      const messages: unknown[] = [];
      await service.send(TOPIC, MSG);
      kv.listenQueue((msg) => { messages.push(msg); });
      await delay(200);
      assert.deepStrictEqual(messages, [MSG_RECEIVED.toRecord()]);
    });
  });

  describe('subscribe', () => {
    it('should start listening to Deno message queue', async () => {
      const messages: Message[] = [];
      const handler = { handle(msg) { messages.push(msg); } } satisfies MessageHandler;
      await service.subscribe([TOPIC], handler);

      await kv.enqueue(MSG_RECEIVED.toRecord());
      await delay();
      assert.deepStrictEqual(messages, [MSG_RECEIVED]);
    });

    it('should close unsubscribed Deno message queue', async () => {
      const handler = { handle() { } };
      const handler2 = { handle() { } };
      await service.subscribe([TOPIC], handler);
      await service.subscribe([TOPIC2], handler2);
      await service.subscribe([], handler);
      assert.strictEqual(service['kv'].has(TOPIC), false);
      assert.strictEqual(service['kv'].has(TOPIC2), true);
    });

    it('should throw if trying to subscribe to invalid topic name', async () => {
      await assert.rejects(
        async () => service.subscribe(['invalid'], { handle() { } }),
        new MessagingError(INVALID_TOPIC_ERR)
      );
    });
  });
});
