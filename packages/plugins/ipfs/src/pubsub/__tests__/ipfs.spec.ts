import { jest } from '@jest/globals';
import { PeerId } from '@libp2p/interface-peer-id';
import { MessageHandler, MessageValidator, MessageValidatorResult, PubSubMessage, PubSubPeerEvent, PubSubPeerMonitor } from '@mithic/messaging';
import { MockEvent, MockIpfs, MockPeer } from '../../__tests__/mocks.js';
import { IpfsPubSub } from '../ipfs.js';
import { Message } from '@libp2p/interface-pubsub';

const PEER_ID = new MockPeer(new Uint8Array([6, 6, 6]));
const DATA = new Uint8Array([1, 2, 3]);
const TOPIC = 'testTopic';
const TOPIC2 = 'testTopic2';
const OPTIONS = {};

describe(IpfsPubSub.name, () => {
  let pubsub: IpfsPubSub;
  let peerMonitor: PubSubPeerMonitor<PeerId>;
  let mockIpfs: MockIpfs;

  beforeEach(() => {
    mockIpfs = new MockIpfs();
    pubsub = new IpfsPubSub(mockIpfs);
    peerMonitor = pubsub['monitor'] as PubSubPeerMonitor<PeerId>;
  });

  afterEach(async () => {
    await pubsub.close();
  });

  describe('close', () => {
    it('should unsubscribe all subscriptions in underlying pubsub', async () => {
      await pubsub.subscribe(TOPIC, () => void 0);
      await pubsub.subscribe(TOPIC2, () => void 0);
      expect(mockIpfs.pubsub.subscribers.has(TOPIC)).toBe(true);
      expect(mockIpfs.pubsub.subscribers.has(TOPIC2)).toBe(true);
      await pubsub.close();
      expect(mockIpfs.pubsub.subscribers.has(TOPIC)).toBe(false);
      expect(mockIpfs.pubsub.subscribers.has(TOPIC2)).toBe(false);
      expect(peerMonitor.started).toBe(false);
    });
  });

  describe('publish', () => {
    it('should publish to underlying pubsub', async () => {
      const publishSpy = jest.spyOn(mockIpfs.pubsub, 'publish');
      const peers = [PEER_ID];
      mockIpfs.pubsub.subscribers.set(TOPIC, peers);

      await pubsub.publish(TOPIC, DATA, OPTIONS);

      expect(publishSpy).toHaveBeenCalledWith(TOPIC, DATA, OPTIONS);
    });
  });

  describe('subscribe/unsubscribe', () => {
    it('should update subscription in underlying pubsub', async () => {
      const validator = jest.fn<MessageValidator<PubSubMessage<Uint8Array, PeerId>>>(() => MessageValidatorResult.Accept);
      const handler = jest.fn<MessageHandler<PubSubMessage<Uint8Array, PeerId>>>();
      const subscribeSpy = jest.spyOn(mockIpfs.pubsub, 'subscribe');

      expect(peerMonitor.started).toBe(false);
      expect(mockIpfs.pubsub.subscribers.has(TOPIC)).toBe(false);

      const options = { validator };
      await pubsub.subscribe(TOPIC, handler, options);

      expect(mockIpfs.pubsub.subscribers.has(TOPIC)).toBe(true);
      expect(peerMonitor.started).toBe(true);
      expect(pubsub['handlers'].get(TOPIC)).toBe(handler);
      expect(pubsub['validators'].get(TOPIC)).toBe(validator);
      expect(subscribeSpy).toHaveBeenCalledWith(TOPIC, pubsub['onMessage'], options);

      const message = new MockEvent('message', { detail: { topic: TOPIC, data: DATA } }) as CustomEvent<Message>;
      await pubsub['onMessage'](message);
      expect(handler).toHaveBeenCalledWith(message.detail);

      await pubsub.unsubscribe(TOPIC);
      expect(mockIpfs.pubsub.subscribers.has(TOPIC)).toBe(false);
      expect(pubsub['handlers'].has(TOPIC)).toBe(false);
      expect(pubsub['validators'].has(TOPIC)).toBe(false);
    });
  });

  describe('topics/subscribers', () => {
    it('should return subscribed topics and subscribers from underlying pubsub', async () => {
      const peers = [PEER_ID];
      mockIpfs.pubsub.subscribers.set(TOPIC, peers);

      expect(await pubsub.topics()).toEqual([TOPIC]);
      expect(await pubsub.subscribers(TOPIC)).toBe(peers);
    });
  });

  describe('addListener/removeListener', () => {
    it.each([
      [PubSubPeerEvent.Join],
      [PubSubPeerEvent.Leave]
    ])('should add/remove peer %s listener in underlying peer monitor', (type: PubSubPeerEvent) => {
      const listener = () => { /* do nothing */ };

      const addListenerSpy = jest.spyOn(peerMonitor, 'addListener');
      const removeListenerSpy = jest.spyOn(peerMonitor, 'removeListener');

      pubsub.addListener(type, listener);
      expect(addListenerSpy).toHaveBeenCalledWith(type, listener);

      pubsub.removeListener(type, listener);
      expect(removeListenerSpy).toHaveBeenCalledWith(type, listener);
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all listeners in underlying peer monitor', () => {
      const removeAllListenersSpy = jest.spyOn(peerMonitor, 'removeAllListeners');
      pubsub.removeAllListeners(PubSubPeerEvent.Join);
      expect(removeAllListenersSpy).toHaveBeenCalledWith(PubSubPeerEvent.Join);
    });
  });
});
