import { jest } from '@jest/globals';
import { PeerId } from '@libp2p/interface-peer-id';
import { StrictNoSign, UnsignedMessage } from '@libp2p/interface-pubsub';
import { MessageHandler, MessageValidator, PubSubMessage, PubSubPeerEvent, PubSubPeerMonitor } from '@mithic/messaging';
import { MockPeer, MockLibp2pPubSub, MockEvent } from '../../__tests__/mocks.js';
import { Libp2pPubSub } from '../libp2p.js';

const PEER_ID = new MockPeer(new Uint8Array([6, 6, 6]));
const DATA = new Uint8Array([1, 2, 3]);
const TOPIC = 'testTopic';
const TOPIC2 = 'testTopic2';

describe(Libp2pPubSub.name, () => {
  let pubsub: Libp2pPubSub;
  let peerMonitor: PubSubPeerMonitor<PeerId>;
  let mockPubSub: MockLibp2pPubSub;

  beforeEach(() => {
    mockPubSub = new MockLibp2pPubSub();
    pubsub = new Libp2pPubSub(mockPubSub);
    peerMonitor = pubsub['monitor'] as PubSubPeerMonitor<PeerId>;
  });

  afterEach(() => {
    pubsub.close();
  });

  describe('strictSign', () => {
    it('should return true/false for StrictSign/StrictNoSign', () => {
      expect(pubsub.strictSign).toBe(true);
      mockPubSub.globalSignaturePolicy = StrictNoSign;
      expect(pubsub.strictSign).toBe(false);
    });
  });

  describe('close', () => {
    it('should unsubscribe all subscriptions in underlying pubsub', () => {
      pubsub.subscribe(TOPIC, () => void 0);
      pubsub.subscribe(TOPIC2, () => void 0);
      expect(mockPubSub.topics.has(TOPIC)).toBe(true);
      expect(mockPubSub.topics.has(TOPIC2)).toBe(true);
      pubsub.close();
      expect(mockPubSub.topics.has(TOPIC)).toBe(false);
      expect(mockPubSub.topics.has(TOPIC2)).toBe(false);
      expect(peerMonitor.started).toBe(false);
    });
  });

  describe('publish', () => {
    it('should publish to underlying pubsub', async () => {
      const publishSpy = jest.spyOn(mockPubSub, 'publish');
      const peers = [PEER_ID];
      mockPubSub.subscribers.set(TOPIC, peers);

      await pubsub.publish(TOPIC, DATA);

      expect(publishSpy).toHaveBeenCalledWith(TOPIC, DATA);
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('should update subscription in underlying pubsub', () => {
      const validator = jest.fn<MessageValidator<PubSubMessage<Uint8Array, PeerId>>>();
      const handler = jest.fn<MessageHandler<PubSubMessage<Uint8Array, PeerId>>>();
      const message: UnsignedMessage = { type: 'unsigned', topic: TOPIC, data: DATA };

      expect(peerMonitor.started).toBe(false);
      expect(mockPubSub.topics.has(TOPIC)).toBe(false);

      pubsub.subscribe(TOPIC, handler, { validator });

      expect(mockPubSub.topics.has(TOPIC)).toBe(true);
      expect(peerMonitor.started).toBe(true);
      expect(pubsub['handlers'].get(TOPIC)).toBe(handler);
      mockPubSub.topicValidators.get(TOPIC)?.(PEER_ID, message);
      expect(validator).toHaveBeenCalledWith(message);

      mockPubSub.dispatchEvent(new MockEvent('message', { detail: message }));
      expect(handler).toHaveBeenCalledWith(message);

      pubsub.unsubscribe(TOPIC);

      expect(mockPubSub.topics.has(TOPIC)).toBe(false);
      expect(pubsub['handlers'].has(TOPIC)).toBe(false);
      expect(mockPubSub.topicValidators.has(TOPIC)).toBe(false);
    });
  });

  describe('topics/subscribers', () => {
    it('should return subscribed topics and subscribers from underlying pubsub', () => {
      mockPubSub.topics.add(TOPIC);
      const peers = [PEER_ID];
      mockPubSub.subscribers.set(TOPIC, peers);

      expect(pubsub.topics()).toEqual([TOPIC]);
      expect(pubsub.subscribers(TOPIC)).toBe(peers);
    });
  });

  describe('addListener/removeListener', () => {
    it.each([
      [PubSubPeerEvent.Join],
      [PubSubPeerEvent.Leave]
    ])('should add/remove peer %s listener in underlying peer monitor', (type: PubSubPeerEvent) => {
      const listener = () => { /* do nothing */ };

      const addListenerSpy = jest.spyOn(peerMonitor, 'addEventListener');
      const removeListenerSpy = jest.spyOn(peerMonitor, 'removeEventListener');

      pubsub.addEventListener(type, listener);
      expect(addListenerSpy).toHaveBeenCalledWith(type, listener);

      pubsub.removeEventListener(type, listener);
      expect(removeListenerSpy).toHaveBeenCalledWith(type, listener);
    });
  });
});
