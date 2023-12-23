import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createEvent, delay } from '@mithic/commons';
import { BroadcastChannelMessageBus, BroadcastChannelMessage, BroadcastChannelMessageType } from '../broadcast-channel.js';
import { PeerAwareMessageOptions, PeerChangeData, PeerEvent } from '../../peer-aware.js';
import { MessageValidationError } from '../../error.js';

const CHANNEL = 'test-channel';
const PEER_ID = 'mockPeerId';
const OTHER_PEER_ID = 'mockOtherPeerId';
const INACTIVE_PEER_ID = 'mockInactivePeerId';
const KEEPALIVE_MS = 50;
const TOPIC = 'test-topic';
const MESSAGE = 123;

describe(BroadcastChannelMessageBus.name, () => {
  let bus: BroadcastChannelMessageBus<number>;
  let subscriber: BroadcastChannel;
  let now = 0;

  beforeEach(() => {
    bus = new BroadcastChannelMessageBus({
      peerId: PEER_ID,
      keepaliveMs: KEEPALIVE_MS,
      now: () => now,
      channel: new BroadcastChannel(CHANNEL),
    });
    subscriber = new BroadcastChannel(CHANNEL);
  });

  afterEach(() => {
    bus.close();
    subscriber.close();
  });

  it('should emit keepalive messages', async () => {
    const handler = jest.fn(() => undefined);
    const receivedMessages: BroadcastChannelMessage<number, string>[] = [];

    subscriber.addEventListener('message', (event) => {
      receivedMessages.push(event.data);
    });

    bus.subscribe(handler, { topic: TOPIC });

    await delay(100); // Wait for keepalive message to be delivered

    expect(receivedMessages).toContainEqual({
      type: BroadcastChannelMessageType.Keepalive,
      topic: TOPIC,
      from: PEER_ID,
    });
  });

  describe('close', () => {
    it('should release resources', () => {
      const handler = jest.fn(() => undefined);
      bus.subscribe(handler, { topic: TOPIC });
      bus['topicSubscribers'].set(TOPIC, new Map([
        [OTHER_PEER_ID, [OTHER_PEER_ID, now]]
      ]));

      const channelCloseSpy = jest.spyOn(bus['channel'], 'close');
      const [, peerMonRemoveListenerSpy] = spyOnPeerMonitor(bus);

      bus.close();

      expect(bus['keepAliveTimer']).toBe(0);
      expect(Array.from(bus.topics())).toEqual([]);
      expect(bus['topicHandlers'].size).toBe(0);
      expect(bus['topicSubscribers'].size).toBe(0);

      expect(channelCloseSpy).toHaveBeenCalledTimes(1);
      expect(peerMonRemoveListenerSpy).toHaveBeenCalledWith(PeerEvent.Join, bus['onPeerJoin']);
      expect(peerMonRemoveListenerSpy).toHaveBeenCalledWith(PeerEvent.Leave, bus['onPeerLeave']);
    });
  });

  describe('subscribe', () => {
    it('should subscribe to channel and return unsubscribe function', () => {
      const handler = jest.fn(() => undefined);
      const validator = jest.fn(() => undefined);

      expect(bus.topics()).not.toContain(TOPIC);

      const unsubscribe = bus.subscribe(handler, { topic: TOPIC, validator });
      expect(bus.topics()).toContain(TOPIC);
      expect(bus['keepAliveTimer']).not.toBe(0);
      expect(bus['topicHandlers'].get(TOPIC)?.length).toBe(1);
      bus['topicHandlers'].get(TOPIC)?.[0](MESSAGE, { topic: TOPIC, from: OTHER_PEER_ID });
      expect(handler).toHaveBeenCalledWith(MESSAGE, { topic: TOPIC, from: OTHER_PEER_ID });
      expect(validator).toHaveBeenCalledWith(MESSAGE, { topic: TOPIC, from: OTHER_PEER_ID });

      unsubscribe();
      expect(bus.topics()).not.toContain(TOPIC);
      expect(bus['topicHandlers'].has(TOPIC)).toBe(false);
    });
  });

  describe('dispatch', () => {
    it('should dispatch to channel', async () => {
      const handler = jest.fn(() => undefined);
      const receivedMessages: BroadcastChannelMessage<number, string>[] = [];

      subscriber.addEventListener('message', (event) => {
        receivedMessages.push(event.data);
      });

      bus.subscribe(handler, { topic: TOPIC });
      bus.dispatch(MESSAGE, { topic: TOPIC });

      await delay(100); // Wait for the message to be delivered

      expect(receivedMessages).toContainEqual({
        type: BroadcastChannelMessageType.Message,
        topic: TOPIC,
        from: PEER_ID,
        data: MESSAGE,
      });
    });
  });

  describe('subscribers', () => {
    it('should return topic subscribers', () => {
      bus['topicSubscribers'].set(TOPIC, new Map([
        [OTHER_PEER_ID, [OTHER_PEER_ID, now]]
      ]));

      expect(Array.from(bus.subscribers({ topic: TOPIC }))).toEqual([OTHER_PEER_ID]);
    });

    it('should clean up inactive topic subscribers', () => {
      const origTime = now;
      now += KEEPALIVE_MS * 1000;
      bus['topicSubscribers'].set(TOPIC, new Map([
        [OTHER_PEER_ID, [OTHER_PEER_ID, now]],
        [INACTIVE_PEER_ID, [INACTIVE_PEER_ID, origTime]]
      ]));

      expect(Array.from(bus.subscribers({ topic: TOPIC }))).toEqual([OTHER_PEER_ID]);
      expect(bus['topicSubscribers'].get(TOPIC)?.has(INACTIVE_PEER_ID)).toBe(false);
    });
  });

  describe('onMessage', () => {
    it('should emit event for valid message', async () => {
      const receivedMessages: [number, PeerAwareMessageOptions<string> | undefined][] = [];
      const handler = jest.fn((msg: number, options?: PeerAwareMessageOptions<string>) => {
        receivedMessages.push([msg, options]);
      });

      bus.subscribe(handler, { topic: TOPIC });
      subscriber.postMessage({
        type: BroadcastChannelMessageType.Message,
        topic: TOPIC,
        from: OTHER_PEER_ID,
        data: MESSAGE,
      });

      await delay(100); // Wait for the message to be delivered

      expect(receivedMessages).toContainEqual([MESSAGE, {
        topic: TOPIC,
        from: OTHER_PEER_ID,
      }]);

      expect(bus['topicSubscribers'].get(TOPIC)?.get(OTHER_PEER_ID)).toEqual([OTHER_PEER_ID, now]);
    });

    it('should update peer lastSeen on keepalive message', async () => {
      const handler = jest.fn(() => undefined);
      bus.subscribe(handler, { topic: TOPIC });

      for (let i = 0; i < 2; ++i, now += 1000) {
        subscriber.postMessage({
          type: BroadcastChannelMessageType.Keepalive,
          topic: TOPIC,
          from: OTHER_PEER_ID,
        });

        await delay(100); // Wait for the message to be delivered

        expect(bus['topicSubscribers'].get(TOPIC)?.get(OTHER_PEER_ID)).toEqual([OTHER_PEER_ID, now]);
      }
    });

    it('should drop malformed message', async () => {
      const receivedMessages: unknown[] = [];
      const handler = jest.fn((event) => {
        receivedMessages.push(event);
      });

      bus.subscribe(handler, { topic: TOPIC });
      subscriber.postMessage('rubbish');

      await delay(100); // Wait for the message to be delivered

      expect(receivedMessages.length).toBe(0);
    });

    it('should drop invalid message', async () => {
      const receivedMessages: unknown[] = [];
      const deliveredMessages: unknown[] = [];
      const handler = jest.fn((message, options) => { deliveredMessages.push([message, options]) });

      bus.subscribe(handler, {
        topic: TOPIC,
        validator: (message, options) => {
          receivedMessages.push([message, options]);
          return new MessageValidationError();
        }
      });
      subscriber.postMessage({
        type: BroadcastChannelMessageType.Message,
        topic: TOPIC,
        from: OTHER_PEER_ID,
        data: MESSAGE,
      });

      await delay(100); // Wait for the message to be delivered

      expect(receivedMessages).toContainEqual([MESSAGE, {
        topic: TOPIC,
        from: OTHER_PEER_ID,
      }]);
      expect(deliveredMessages.length).toBe(0);
    });
  });

  describe('onPeerEvent', () => {
    it('should monitor and emit peer events', () => {
      const handler = jest.fn(() => undefined);
      const receivedMessages: unknown[] = [];

      bus.addEventListener(PeerEvent.Join, (event) => {
        receivedMessages.push(event.detail);
      });
      bus.addEventListener(PeerEvent.Leave, (event) => {
        receivedMessages.push(event.detail);
      });
      bus.subscribe(handler, { topic: TOPIC });

      const [peerMonitor,] = spyOnPeerMonitor(bus);
      const event: PeerChangeData<string> = { topic: TOPIC, peers: [OTHER_PEER_ID] };

      for (const eventType of [PeerEvent.Join, PeerEvent.Leave] as const) {
        receivedMessages.length = 0;
        peerMonitor.dispatchEvent(createEvent(eventType, event));
        expect(receivedMessages).toEqual([event]);
      }
    });
  });
});

function spyOnPeerMonitor<T>(pubsub: BroadcastChannelMessageBus<T>) {
  const peerMonitor = pubsub['peerMonitor'];
  if (!peerMonitor) { throw new Error('peerMonitor is undefined'); }
  return [peerMonitor, jest.spyOn(peerMonitor, 'removeEventListener')] as const;
}
