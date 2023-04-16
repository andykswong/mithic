import { jest } from '@jest/globals';
import { PubSubPeerEvent } from '../../pubsub.js';
import { DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS, PubSubPeerMonitor } from '../monitor.js';
import { MockPeer, MockPubSub } from '../../__tests__/mocks.js';
import { flushPromises } from '../../__tests__/utils.js';

const PEER_ID = new MockPeer(new Uint8Array([6, 6, 6]));
const PEER_ID2 = new MockPeer(new Uint8Array([7, 7, 7]));
const PEER_ID3 = new MockPeer(new Uint8Array([8, 8, 8]));
const TOPIC = 'testTopic';

describe(PubSubPeerMonitor.name, () => {
  let peerMonitor: PubSubPeerMonitor<MockPeer>;
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

    peerMonitor = new PubSubPeerMonitor(mockPubSub);
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

      jest.advanceTimersByTime(DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS);
      await flushPromises();

      peerMonitor.addListener(PubSubPeerEvent.Join, (event) => {
        expect(event.topic).toBe(TOPIC);
        expect(event.peers).toEqual([PEER_ID3]);
      });

      peerMonitor.addListener(PubSubPeerEvent.Leave, (event) => {
        expect(event.topic).toBe(TOPIC);
        expect(event.peers).toEqual([PEER_ID]);
      });

      mockPubSub.subscriberMap.set(TOPIC, [PEER_ID2, PEER_ID3]);

      jest.advanceTimersByTime(DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS);
    });

    it('should update peers map on subscribe/unsubscribe', async () => {
      expect.assertions(2);

      jest.advanceTimersByTime(DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS);
      await flushPromises();
      expect(peerMonitor['peers'].get(TOPIC)).toEqual([PEER_ID, PEER_ID2]);

      mockPubSub.subscriberMap.clear();

      jest.advanceTimersByTime(DEFAULT_PUBSUB_PEER_MONITOR_REFRESH_MS);
      await flushPromises();

      expect(peerMonitor['peers'].has(TOPIC)).toBe(false);
    });
  });
});
