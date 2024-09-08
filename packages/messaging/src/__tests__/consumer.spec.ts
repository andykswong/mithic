import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { delay, dispose } from '@mithic/commons';
import { runWorker } from '#tests/worker';
import { BroadcastChannelMessagingService } from '../impl/index.ts';
import { Messaging } from '../provider/index.ts';
import { subscribe } from '../consumer.ts';
import { IncomingHandlerFQN, type Message, type MessagingGuest } from '../types.ts';

const TOPIC = 'topic';
const MSG: Message = { topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) };

describe('consumer', () => {
  let worker: Worker;
  let service: BroadcastChannelMessagingService;

  beforeEach(async () => {
    const channel = `channel${(Math.random() * 10000) | 0}`;
    service = new BroadcastChannelMessagingService({ channel });
    [worker, Messaging.provider] = runWorker({ channel, topics: [TOPIC] });
  });

  afterEach(async () => {
    dispose(service);
    await worker?.terminate();
  });

  describe('subscribe', () => {
    it('should subscribe to topic', async () => {
      const messages: Message[] = [];
      const guest: MessagingGuest = {
        [IncomingHandlerFQN]: {
          handle: (msg: Message) => { messages.push(msg); },
        },
      };
      Messaging.setHandler(guest);
      subscribe([TOPIC]);
      service.send(MSG);
      await delay(100);
      expect(messages).toEqual([MSG]);
    });
  });
});
