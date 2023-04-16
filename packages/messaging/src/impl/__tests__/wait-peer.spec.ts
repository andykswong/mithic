import { jest } from '@jest/globals';
import { ErrorName } from '@mithic/commons';
import { CONNECTION_CHECK_INTERVAL_MS, isPeerConnected, waitForPeer } from '../wait-peer.js';
import { MockPeer, MockPubSub } from '../../__tests__/mocks.js';
import { flushPromises } from '../../__tests__/utils.js';

const PEER_ID = new MockPeer(new Uint8Array([6, 6, 6]));
const PEER_ID2 = new MockPeer(new Uint8Array([7, 7, 7]));
const PEER_ID3 = new MockPeer(new Uint8Array([8, 8, 8]));
const TOPIC = 'testTopic';
const TOPIC2 = 'testTopic2';

describe(isPeerConnected.name, () => {
  let mockPubSub: MockPubSub;

  beforeEach(() => {
    mockPubSub = new MockPubSub();
    mockPubSub.subscriberMap.set(TOPIC, [PEER_ID, PEER_ID2]);
  });

  it('should return true if peer is in subscribers list', async () => {
    expect(await isPeerConnected(mockPubSub, TOPIC, PEER_ID)).toBe(true);
  });

  it('should return false if peer is in not subscribers list', async () => {
    expect(await isPeerConnected(mockPubSub, TOPIC, PEER_ID3)).toBe(false);
  });
});

describe(waitForPeer.name, () => {
  let mockPubSub: MockPubSub;

  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    mockPubSub = new MockPubSub();
    mockPubSub.subscriberMap.set(TOPIC, [PEER_ID, PEER_ID2]);
  });

  it('should return immediately if peer is already connected', async () => {
    expect.assertions(1);
    await waitForPeer(mockPubSub, TOPIC, PEER_ID);
    expect(true).toBe(true);
  });

  it('should resolve once peer is connected', async () => {
    expect.assertions(1);
    const p = waitForPeer(mockPubSub, TOPIC, PEER_ID3);
    await flushPromises();
    mockPubSub.subscriberMap.set(TOPIC, [PEER_ID3]);
    jest.advanceTimersByTime(CONNECTION_CHECK_INTERVAL_MS);
    await p;
    expect(true).toBe(true);
  });

  it('should reject with AbortError if topic closed', async () => {
    expect.assertions(1);
    try {
      const p = waitForPeer(mockPubSub, TOPIC2, PEER_ID3);
      await flushPromises();
      jest.advanceTimersByTime(CONNECTION_CHECK_INTERVAL_MS);
      await p;
    } catch (e) {
      expect((e as Error).name).toBe(ErrorName.Abort);
    }
  });

  it('should reject with AbortError if aborted', async () => {
    expect.assertions(1);
    const controller = new AbortController();
    try {
      const p = waitForPeer(mockPubSub, TOPIC, PEER_ID3, { signal: controller.signal });
      controller.abort();
      await flushPromises();
      jest.advanceTimersByTime(CONNECTION_CHECK_INTERVAL_MS);
      await p;
    } catch (e) {
      expect((e as Error).name).toBe(ErrorName.Abort);
    }
  });
});
