import { jest } from '@jest/globals';
import { wait } from '@mithic/commons';
import { PubSubPeerChangeEvent, PubSubMessage, MessageValidator, MessageValidatorResult, PubSubPeerEvent, MessageHandler } from '../../index.js';
import { BroadcastChannelPubSub, BroadcastChannelPubSubMessage, BroadcastChannelPubSubMessageType } from '../broadcast-channel.js';

const PEER_ID = 'mockPeerId';
const OTHER_PEER_ID = 'mockOtherPeerId';
const INACTIVE_PEER_ID = 'mockInactivePeerId';
const KEEPALIVE_MS = 50;
const TOPIC = 'test-topic';
const MESSAGE = 123;

describe(BroadcastChannelPubSub.name, () => {
  let pubsub: BroadcastChannelPubSub<number>;
  let subscriber: BroadcastChannel;
  let now = 0;

  beforeEach(() => {
    pubsub = new BroadcastChannelPubSub({
      peerId: PEER_ID,
      keepaliveMs: KEEPALIVE_MS,
      now: () => now,
    });
    subscriber = new BroadcastChannel(TOPIC);
  });

  afterEach(() => {
    pubsub.close();
    subscriber.close();
  });

  test('close', () => {
    const handler = jest.fn<MessageHandler<PubSubMessage<number, string>>>();
    pubsub.subscribe(TOPIC, handler);
    pubsub['topicSubscribers'].set(TOPIC, new Map([
      [OTHER_PEER_ID, [OTHER_PEER_ID, now]]
    ]));

    const [, peerMonRemoveListenerSpy] = spyOnPeerMonitor(pubsub);
    const [, channelCloseSpy] = spyOnChannel(pubsub);

    pubsub.close();

    expect(pubsub['keepAliveTimer']).toBe(0);
    expect(Array.from(pubsub.topics())).toEqual([]);
    expect(pubsub['topicHandlers'].size).toBe(0);
    expect(pubsub['topicSubscribers'].size).toBe(0);

    expect(peerMonRemoveListenerSpy).toHaveBeenCalledWith(PubSubPeerEvent.Join, pubsub['onPeerJoinEvent']);
    expect(peerMonRemoveListenerSpy).toHaveBeenCalledWith(PubSubPeerEvent.Leave, pubsub['onPeerLeaveEvent']);

    expect(channelCloseSpy).toBeCalled();
  });

  test('subscribe and unsubscribe', () => {
    const handler = jest.fn<MessageHandler<PubSubMessage<number, string>>>();
    const validator = jest.fn<MessageValidator<PubSubMessage<number, string>>>();

    expect(pubsub.topics()).not.toContain(TOPIC);

    pubsub.subscribe(TOPIC, handler, { validator });
    expect(pubsub.topics()).toContain(TOPIC);
    expect(pubsub['keepAliveTimer']).not.toBe(0);
    expect(pubsub['topicHandlers'].get(TOPIC)).toBe(handler);
    expect(pubsub['topicValidators'].get(TOPIC)).toBe(validator);

    const [channel, channelCloseSpy] = spyOnChannel(pubsub);

    pubsub.subscribe(TOPIC, handler, { validator });
    expect(pubsub['topicChannels'].get(TOPIC)).toBe(channel); // should reuse channel

    pubsub.unsubscribe(TOPIC);
    expect(pubsub.topics()).not.toContain(TOPIC);
    expect(pubsub['topicHandlers'].has(TOPIC)).toBe(false);
    expect(pubsub['topicValidators'].has(TOPIC)).toBe(false);
    expect(channelCloseSpy).toBeCalled();

    pubsub.unsubscribe(TOPIC); // should do nothing
    expect(channelCloseSpy).toBeCalledTimes(1);
  });

  test('publish', async () => {
    const handler = jest.fn<MessageHandler<PubSubMessage<number, string>>>();
    const receivedMessages: BroadcastChannelPubSubMessage<number, string>[] = [];

    subscriber.addEventListener('message', (event) => {
      receivedMessages.push(event.data);
    });

    pubsub.subscribe(TOPIC, handler);
    pubsub.publish(TOPIC, MESSAGE);

    await wait(100); // Wait for the message to be delivered

    expect(receivedMessages).toContainEqual({
      type: BroadcastChannelPubSubMessageType.Message,
      from: PEER_ID,
      data: MESSAGE,
    });
  });

  describe('subscribers', () => {
    it('should return topic subscribers', () => {
      pubsub['topicSubscribers'].set(TOPIC, new Map([
        [OTHER_PEER_ID, [OTHER_PEER_ID, now]]
      ]));

      expect(Array.from(pubsub.subscribers(TOPIC))).toEqual([OTHER_PEER_ID]);
    });

    it('should clean up inactive topic subscribers', () => {
      const origTime = now;
      now += KEEPALIVE_MS * 1000;
      pubsub['topicSubscribers'].set(TOPIC, new Map([
        [OTHER_PEER_ID, [OTHER_PEER_ID, now]],
        [INACTIVE_PEER_ID, [INACTIVE_PEER_ID, origTime]]
      ]));

      expect(Array.from(pubsub.subscribers(TOPIC))).toEqual([OTHER_PEER_ID]);
      expect(pubsub['topicSubscribers'].get(TOPIC)?.has(INACTIVE_PEER_ID)).toBe(false);
    });
  });

  test('keepalive', async () => {
    const handler = jest.fn<MessageHandler<PubSubMessage<number, string>>>();
    const receivedMessages: BroadcastChannelPubSubMessage<number, string>[] = [];

    subscriber.addEventListener('message', (event) => {
      receivedMessages.push(event.data);
    });

    pubsub.subscribe(TOPIC, handler);

    await wait(100); // Wait for keepalive message to be delivered

    expect(receivedMessages).toContainEqual({
      type: BroadcastChannelPubSubMessageType.Keepalive,
      from: PEER_ID,
    });
  });

  describe('onMessage', () => {
    it('should emit event for valid message', async () => {
      const receivedMessages: PubSubMessage<number, string>[] = [];
      const handler = jest.fn<MessageHandler<PubSubMessage<number, string>>>((event) => {
        receivedMessages.push(event);
      });

      pubsub.subscribe(TOPIC, handler);
      subscriber.postMessage({
        type: BroadcastChannelPubSubMessageType.Message,
        from: OTHER_PEER_ID,
        data: MESSAGE,
      });

      await wait(100); // Wait for the message to be delivered

      expect(receivedMessages).toContainEqual({
        topic: TOPIC,
        data: MESSAGE,
        from: OTHER_PEER_ID,
      });

      expect(pubsub['topicSubscribers'].get(TOPIC)?.get(OTHER_PEER_ID)).toEqual([OTHER_PEER_ID, now]);
    });

    it('should update peer lastSeen on keepalive message', async () => {
      const handler = jest.fn<MessageHandler<PubSubMessage<number, string>>>();
      pubsub.subscribe(TOPIC, handler);

      for (let i = 0; i < 2; ++i, now += 1000) {
        subscriber.postMessage({
          type: BroadcastChannelPubSubMessageType.Keepalive,
          from: OTHER_PEER_ID,
        });

        await wait(100); // Wait for the message to be delivered

        expect(pubsub['topicSubscribers'].get(TOPIC)?.get(OTHER_PEER_ID)).toEqual([OTHER_PEER_ID, now]);
      }
    });

    it('should drop malformed message', async () => {
      const receivedMessages: PubSubMessage<number, string>[] = [];
      const handler = jest.fn<MessageHandler<PubSubMessage<number, string>>>((event) => {
        receivedMessages.push(event);
      });

      pubsub.subscribe(TOPIC, handler);
      subscriber.postMessage('rubbish');

      await wait(100); // Wait for the message to be delivered

      expect(receivedMessages.length).toBe(0);
    });

    it('should drop invalid message', async () => {
      const receivedMessages: PubSubMessage<number, string>[] = [];
      const deliveredMessages: PubSubMessage<number, string>[] = [];

      const handler = jest.fn<MessageHandler<PubSubMessage<number, string>>>((event) => {
        deliveredMessages.push(event);
      });

      pubsub.subscribe(TOPIC, handler, {
        validator: (message) => {
          receivedMessages.push(message);
          return MessageValidatorResult.Reject;
        }
      });
      subscriber.postMessage({
        type: BroadcastChannelPubSubMessageType.Message,
        from: OTHER_PEER_ID,
        data: MESSAGE,
      });

      await wait(100); // Wait for the message to be delivered

      expect(receivedMessages).toContainEqual({
        topic: TOPIC,
        data: MESSAGE,
        from: OTHER_PEER_ID,
      });
      expect(deliveredMessages.length).toBe(0);
    });
  });

  test('onPeerEvent', () => {
    const handler = jest.fn<MessageHandler<PubSubMessage<number, string>>>();
    const receivedMessages: PubSubPeerChangeEvent<string>[] = [];

    pubsub.addListener(PubSubPeerEvent.Join, (event) => {
      receivedMessages.push(event);
    });
    pubsub.addListener(PubSubPeerEvent.Leave, (event) => {
      receivedMessages.push(event);
    });
    pubsub.subscribe(TOPIC, handler);

    const [peerMonitor,] = spyOnPeerMonitor(pubsub);
    const event: PubSubPeerChangeEvent<string> = { topic: TOPIC, peers: [OTHER_PEER_ID] };

    for (const eventType of [PubSubPeerEvent.Join, PubSubPeerEvent.Leave] as const) {
      receivedMessages.length = 0;
      peerMonitor.emit(eventType, event);
      expect(receivedMessages).toEqual([event]);
    }
  });
});

function spyOnChannel<T>(pubsub: BroadcastChannelPubSub<T>) {
  const channel = pubsub['topicChannels'].get(TOPIC);
  if (!channel) { throw new Error('channel is undefined'); }
  return [channel, jest.spyOn(channel, 'close')] as const;
}

function spyOnPeerMonitor<T>(pubsub: BroadcastChannelPubSub<T>) {
  const peerMonitor = pubsub['peerMonitor'];
  if (!peerMonitor) { throw new Error('peerMonitor is undefined'); }
  return [peerMonitor, jest.spyOn(peerMonitor, 'removeListener')] as const;
}
