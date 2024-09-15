import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Kv, openKv } from '@deno/kv';
import { delay, dispose } from '@mithic/commons';
import { MessagingError, MessagingErrorType, type Message } from '@mithic/messaging';
import { DenoKvMessagingService } from './index.ts';

const TOPIC = 'testTopic';
const TOPIC2 = 'test2';
const MSG: Message = { topic: TOPIC, metadata: [], data: new Uint8Array([1]) };
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
        throw new MessagingError({ tag: MessagingErrorType.Unauthorized });
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
      await service.send(MSG);
      kv.listenQueue((msg) => { messages.push(msg); });
      await delay(200);
      assert.deepStrictEqual(messages, [MSG]);
    });
  });

  describe('subscribe', () => {
    it('should start listening to Deno message queue', async () => {
      const messages: Message[] = [];
      service.onmessage = (msg) => { messages.push(msg); };
      await service.subscribe([TOPIC]);

      await kv.enqueue(MSG);
      await delay();
      assert.deepStrictEqual(messages, [MSG]);
    });

    it('should close unsubscribed Deno message queue', async () => {
      await service.subscribe([TOPIC, TOPIC2]);
      await service.subscribe([TOPIC]);
      assert.strictEqual(service['kv'].has(TOPIC2), false);
    });

    it('should throw if trying to subscribe to invalid topic name', async () => {
      await assert.rejects(
        async () => service.subscribe(['invalid']),
        new MessagingError({ tag: MessagingErrorType.Unauthorized })
      );
    });
  });
});
