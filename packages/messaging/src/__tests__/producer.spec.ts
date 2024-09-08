import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { delay, dispose } from '@mithic/commons';
import { runWorker } from '#tests/worker';
import { BroadcastChannelMessagingService } from '../impl/index.ts';
import { Messaging } from '../provider/index.ts';
import { MessageMetadata, type Message, type PeerId } from '../types.ts';
import { send } from '../producer.ts';

const TOPIC = 'topic';
const PEER = 'peer' as PeerId;
const MSG: Message = { topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) };

describe('producer', () => {
  let worker: Worker;
  let service: BroadcastChannelMessagingService;

  beforeEach(async () => {
    const channel = `channel${(Math.random() * 10000) | 0}`;
    service = new BroadcastChannelMessagingService({ channel });
    [worker, Messaging.provider] = runWorker({ channel, peerId: PEER, topics: [TOPIC] });
  });

  afterEach(async () => {
    dispose(service);
    await worker?.terminate();
  });

  describe('send', () => {
    it('should send message to topic', async () => {
      const messages: Message[] = [];
      service.onmessage = (msg) => { messages.push(msg); }
      service.subscribe([TOPIC]);
      send(MSG);
      await delay(100);
      expect(messages).toEqual([{ ...MSG, metadata: [[MessageMetadata.From, PEER]] }]);
    });
  });
});
