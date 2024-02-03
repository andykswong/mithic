import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DEFAULT_PEER_MONITOR_REFRESH_MS, PeerSubscriptionMonitor } from '../peer-monitor.ts';
import { MockPeer, MockMessageBus } from '../../__tests__/mocks.ts';
import { flushPromises } from '../../__tests__/utils.ts';
import { PeerEvent } from '../../peer-aware.ts';

const PEER_ID = new MockPeer(new Uint8Array([6, 6, 6]));
const PEER_ID2 = new MockPeer(new Uint8Array([7, 7, 7]));
const PEER_ID3 = new MockPeer(new Uint8Array([8, 8, 8]));
const TOPIC = 'testTopic';

describe(PeerSubscriptionMonitor.name, () => {
  let peerMonitor: PeerSubscriptionMonitor<MockPeer>;
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

    peerMonitor = new PeerSubscriptionMonitor(mockPubSub);
  });

  afterEach(() => {
    peerMonitor.close();
  });

  it('should auto-start', () => {
    expect(peerMonitor.started).toBe(true);
  });

  describe('close', () => {
    it('should clean up the monitor', () => {
      peerMonitor.close();
      expect(peerMonitor['pollTimer']).toBe(0);
      expect(peerMonitor['peers'].size).toBe(0);
    });
  });

  describe('event', () => {
    it('should emit join and leave events when peer list changes', async () => {
      let joinCount = 0;
      let leaveCount = 0;

      jest.advanceTimersByTime(DEFAULT_PEER_MONITOR_REFRESH_MS);
      await flushPromises();

      peerMonitor.addEventListener(PeerEvent.Join, (event) => {
        expect(event.detail.topic).toBe(TOPIC);
        expect(event.detail.peers).toEqual([PEER_ID3]);
        ++joinCount;
      });

      peerMonitor.addEventListener(PeerEvent.Leave, (event) => {
        expect(event.detail.topic).toBe(TOPIC);
        expect(event.detail.peers).toEqual([PEER_ID]);
        ++leaveCount;
      });

      mockPubSub.subscriberMap.set(TOPIC, [PEER_ID2, PEER_ID3]);

      jest.advanceTimersByTime(DEFAULT_PEER_MONITOR_REFRESH_MS);
      await flushPromises();

      expect(joinCount).toBe(1);
      expect(leaveCount).toBe(1);
    });

    it('should update peers map on subscribe/unsubscribe', async () => {
      jest.advanceTimersByTime(DEFAULT_PEER_MONITOR_REFRESH_MS);
      await flushPromises();

      expect(peerMonitor['peers'].get(TOPIC)).toEqual([PEER_ID, PEER_ID2]);

      mockPubSub.subscriberMap.clear();

      jest.advanceTimersByTime(DEFAULT_PEER_MONITOR_REFRESH_MS);
      await flushPromises();

      expect(peerMonitor['peers'].has(TOPIC)).toBe(false);
    });
  });
});
