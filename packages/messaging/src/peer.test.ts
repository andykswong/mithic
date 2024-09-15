import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Worker } from 'node:worker_threads';
import { delay, dispose } from '@mithic/commons';
import { runWorker } from './test/worker.ts';
import { listSubscribers } from './peer.ts';
import { BroadcastChannelMessagingService, Messaging, type PeerId } from './index.ts';

const CHANNEL = 'message';
const TOPIC = 'topic';
const PEER = 'peer' as PeerId;
const PEER2 = 'peer2' as PeerId;

describe('peer', () => {
  let worker: Worker;
  let service: BroadcastChannelMessagingService;

  beforeEach(async () => {
    service = new BroadcastChannelMessagingService({ channel: CHANNEL, peerId: PEER2, keepaliveMs: 20 });
    [worker, Messaging.provider] = runWorker({ channel: CHANNEL, peerId: PEER, topics: [TOPIC] });
  });

  afterEach(async () => {
    dispose(service);
    await worker?.terminate();
  });

  describe('listSubscribers', () => {
    it('should return subscribers to topic', async () => {
      service.subscribe([TOPIC]);
      Messaging.provider.subscribe([TOPIC]);
      await delay(100); // wait for peer discovery
      assert.deepStrictEqual(listSubscribers(TOPIC), [PEER, PEER2]);
    });
  });
});
