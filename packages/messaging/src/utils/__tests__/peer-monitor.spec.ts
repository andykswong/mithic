import { jest } from '@jest/globals';
import { DEFAULT_PEER_MONITOR_REFRESH_MS, PeerSubscriptionMonitor } from '../peer-monitor.js';
import { MockPeer, MockMessageBus } from '../../__tests__/mocks.js';
import { flushPromises } from '../../__tests__/utils.js';
import { PeerEvent } from '../../peer-aware.js';

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
      expect.assertions(4);

      jest.advanceTimersByTime(DEFAULT_PEER_MONITOR_REFRESH_MS);
      await flushPromises();

      peerMonitor.addEventListener(PeerEvent.Join, (event) => {
        expect(event.detail.topic).toBe(TOPIC);
        expect(event.detail.peers).toEqual([PEER_ID3]);
      });

      peerMonitor.addEventListener(PeerEvent.Leave, (event) => {
        expect(event.detail.topic).toBe(TOPIC);
        expect(event.detail.peers).toEqual([PEER_ID]);
      });

      mockPubSub.subscriberMap.set(TOPIC, [PEER_ID2, PEER_ID3]);

      jest.advanceTimersByTime(DEFAULT_PEER_MONITOR_REFRESH_MS);
    });

    it('should update peers map on subscribe/unsubscribe', async () => {
      expect.assertions(2);

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
