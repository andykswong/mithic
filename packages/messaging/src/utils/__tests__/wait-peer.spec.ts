import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { CONNECTION_CHECK_INTERVAL_MS, isPeerConnected, waitForPeer } from '../wait-peer.ts';
import { MockPeer, MockMessageBus } from '../../__tests__/mocks.ts';
import { flushPromises } from '../../__tests__/utils.ts';

const PEER_ID = new MockPeer(new Uint8Array([6, 6, 6]));
const PEER_ID2 = new MockPeer(new Uint8Array([7, 7, 7]));
const PEER_ID3 = new MockPeer(new Uint8Array([8, 8, 8]));
const TOPIC = 'testTopic';
const TOPIC2 = 'testTopic2';

describe(isPeerConnected.name, () => {
  let bus: MockMessageBus;

  beforeEach(() => {
    bus = new MockMessageBus();
    bus.subscriberMap.set(TOPIC, [PEER_ID, PEER_ID2]);
  });

  it('should return true if peer is in subscribers list', async () => {
    expect(await isPeerConnected(bus, TOPIC, PEER_ID)).toBe(true);
  });

  it('should return false if peer is in not subscribers list', async () => {
    expect(await isPeerConnected(bus, TOPIC, PEER_ID3)).toBe(false);
  });
});

describe(waitForPeer.name, () => {
  let mockPubSub: MockMessageBus;

  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  beforeEach(() => {
    mockPubSub = new MockMessageBus();
    mockPubSub.subscriberMap.set(TOPIC, [PEER_ID, PEER_ID2]);
  });

  it('should return immediately if peer is already connected', async () => {
    await waitForPeer(mockPubSub, TOPIC, PEER_ID);
  });

  it('should resolve once peer is connected', async () => {
    const p = waitForPeer(mockPubSub, TOPIC, PEER_ID3);
    await flushPromises();
    mockPubSub.subscriberMap.set(TOPIC, [PEER_ID3]);
    jest.advanceTimersByTime(CONNECTION_CHECK_INTERVAL_MS);
    await p;
  });

  it('should reject with AbortError if topic closed', async () => {
    let err: unknown;
    try {
      const p = waitForPeer(mockPubSub, TOPIC2, PEER_ID3);
      await flushPromises();
      jest.advanceTimersByTime(CONNECTION_CHECK_INTERVAL_MS);
      await p;
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.name).toBe('AbortError');
  });

  it('should reject with AbortError if aborted', async () => {
    let err: unknown;
    const controller = new AbortController();
    try {
      const p = waitForPeer(mockPubSub, TOPIC, PEER_ID3, { signal: controller.signal });
      controller.abort();
      await flushPromises();
      jest.advanceTimersByTime(CONNECTION_CHECK_INTERVAL_MS);
      await p;
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.name).toBe('AbortError');
  });
});
