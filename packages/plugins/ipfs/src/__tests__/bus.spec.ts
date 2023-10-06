import { jest } from '@jest/globals';
import { PeerId } from '@libp2p/interface-peer-id';
import { SignedMessage, StrictNoSign, UnsignedMessage } from '@libp2p/interface-pubsub';
import { PeerEvent, PeerSubscriptionMonitor } from '@mithic/messaging';
import { MockPeer, MockLibp2pPubSub, MockEvent } from '../__tests__/mocks.js';
import { Libp2pMessageBus } from '../bus.js';

const PEER_ID = new MockPeer(new Uint8Array([6, 6, 6]));
const DATA = new Uint8Array([1, 2, 3]);
const TOPIC = 'testTopic';
const TOPIC2 = 'testTopic2';

describe(Libp2pMessageBus.name, () => {
  let bus: Libp2pMessageBus;
  let peerMonitor: PeerSubscriptionMonitor<PeerId>;
  let mockPubSub: MockLibp2pPubSub;

  beforeEach(() => {
    mockPubSub = new MockLibp2pPubSub();
    bus = new Libp2pMessageBus(mockPubSub);
    peerMonitor = bus['monitor']!;
  });

  afterEach(() => {
    bus.close();
  });

  describe('strictSign', () => {
    it('should return true/false for StrictSign/StrictNoSign', () => {
      expect(bus.strictSign).toBe(true);
      mockPubSub.globalSignaturePolicy = StrictNoSign;
      expect(bus.strictSign).toBe(false);
    });
  });

  describe('close', () => {
    it('should unsubscribe all subscriptions in underlying pubsub', () => {
      bus.subscribe(() => void 0, { topic: TOPIC });
      bus.subscribe(() => void 0, { topic: TOPIC2 });
      expect(mockPubSub.topics.has(TOPIC)).toBe(true);
      expect(mockPubSub.topics.has(TOPIC2)).toBe(true);
      bus.close();
      expect(mockPubSub.topics.has(TOPIC)).toBe(false);
      expect(mockPubSub.topics.has(TOPIC2)).toBe(false);
      expect(peerMonitor.started).toBe(false);
    });
  });

  describe('dispatch', () => {
    it('should publish to underlying pubsub', async () => {
      const publishSpy = jest.spyOn(mockPubSub, 'publish');
      const peers = [PEER_ID];
      mockPubSub.subscribers.set(TOPIC, peers);

      await bus.dispatch(DATA, { topic: TOPIC });

      expect(publishSpy).toHaveBeenCalledWith(TOPIC, DATA);
    });

    it('should publish to defaultTopic if topic is not specified', async () => {
      const publishSpy = jest.spyOn(mockPubSub, 'publish');
      const peers = [PEER_ID];
      mockPubSub.subscribers.set(TOPIC, peers);

      await bus.dispatch(DATA);

      expect(publishSpy).toHaveBeenCalledWith(bus.defaultTopic, DATA);
    });
  });

  describe('subscribe', () => {
    it('should update subscription in underlying pubsub', () => {
      const validator = jest.fn(() => undefined);
      const handler = jest.fn(() => undefined);
      const message: SignedMessage = {
        type: 'signed', topic: TOPIC, data: DATA, from: PEER_ID,
        sequenceNumber: 1n, signature: new Uint8Array(), key: new Uint8Array(),
      };

      expect(peerMonitor.started).toBe(false);
      expect(mockPubSub.topics.has(TOPIC)).toBe(false);

      bus.subscribe(handler, { validator, topic: TOPIC });

      expect(mockPubSub.topics.has(TOPIC)).toBe(true);
      expect(peerMonitor.started).toBe(true);
      expect(bus['handlers'].get(TOPIC)).toEqual([handler]);
      expect(bus['validators'].get(TOPIC)).toEqual([validator]);

      mockPubSub.topicValidators.get(TOPIC)?.(PEER_ID, message);
      expect(validator).toHaveBeenCalledWith(DATA, { topic: TOPIC, from: PEER_ID });

      mockPubSub.dispatchEvent(new MockEvent('message', { detail: message }));
      expect(handler).toHaveBeenCalledWith(DATA, { topic: TOPIC, from: PEER_ID });
    });

    it('should handle unsigned messages', () => {
      const validator = jest.fn(() => undefined);
      const handler = jest.fn(() => undefined);
      const message: UnsignedMessage = { type: 'unsigned', topic: TOPIC, data: DATA };

      bus.subscribe(handler, { topic: TOPIC, validator });

      mockPubSub.topicValidators.get(TOPIC)?.(PEER_ID, message);
      expect(validator).toHaveBeenCalledWith(DATA, { topic: TOPIC });

      mockPubSub.dispatchEvent(new MockEvent('message', { detail: message }));
      expect(handler).toHaveBeenCalledWith(DATA, { topic: TOPIC });
    });

    it('should return function to unsubscribe from underlying pubsub', () => {
      const validator = jest.fn(() => undefined);
      const handler = jest.fn(() => undefined);
      const unsubscribe = bus.subscribe(handler, { topic: TOPIC, validator });
      unsubscribe();

      expect(mockPubSub.topics.has(TOPIC)).toBe(false);
      expect(bus['handlers'].get(TOPIC)?.length).toBe(0);
      expect(bus['validators'].get(TOPIC)?.length).toBe(0);
      expect(mockPubSub.topicValidators.has(TOPIC)).toBe(false);
    });
  });

  describe('topics', () => {
    it('should return subscribed topics from underlying pubsub', () => {
      mockPubSub.topics.add(TOPIC);
      const peers = [PEER_ID];
      mockPubSub.subscribers.set(TOPIC, peers);

      expect(bus.topics()).toEqual([TOPIC]);
    });
  });

  describe('subscribers', () => {
    it('should return subscribers from underlying pubsub', () => {
      mockPubSub.topics.add(TOPIC);
      const peers = [PEER_ID];
      mockPubSub.subscribers.set(TOPIC, peers);

      expect(bus.subscribers({ topic: TOPIC })).toBe(peers);
    });
  });

  describe('addListener/removeListener', () => {
    it.each([
      [PeerEvent.Join],
      [PeerEvent.Leave]
    ])('should add/remove peer %s listener in underlying peer monitor', (type) => {
      const listener = () => { /* do nothing */ };

      const addListenerSpy = jest.spyOn(peerMonitor, 'addEventListener');
      const removeListenerSpy = jest.spyOn(peerMonitor, 'removeEventListener');

      bus.addEventListener(type, listener);
      expect(addListenerSpy).toHaveBeenCalledWith(type, listener);

      bus.removeEventListener(type, listener);
      expect(removeListenerSpy).toHaveBeenCalledWith(type, listener);
    });
  });
});
