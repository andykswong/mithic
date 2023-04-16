import { jest } from '@jest/globals';
import { PeerMessage } from '../../p2p.js';
import { MessageHandler, MessageValidatorResult } from '../../pubsub.js';
import { PubSubDirectChannel, PUBSUB_DIRECT_CHANNEL_PROTOCOL_NAME, PUBSUB_DIRECT_CHANNEL_PROTOCOL_SEMVER } from '../pubsub-direct.js';
import { MockPeer, MockPubSub } from '../../__tests__/mocks.js';

const PEER_ID = new MockPeer(new Uint8Array([6, 6, 6]));
const OTHER_PEER_ID = new MockPeer(new Uint8Array([7, 7, 7]));
const TOPIC = `/${PUBSUB_DIRECT_CHANNEL_PROTOCOL_NAME}/${PUBSUB_DIRECT_CHANNEL_PROTOCOL_SEMVER}/${PEER_ID}/${OTHER_PEER_ID}`;
const DATA = new Uint8Array([1, 2, 3]);

describe(PubSubDirectChannel.name, () => {
  let channel: PubSubDirectChannel<Uint8Array, MockPeer>;
  let mockPubSub: MockPubSub;
  let publishSpy: jest.SpiedFunction<MockPubSub['publish']>;

  beforeEach(() => {
    mockPubSub = new MockPubSub();
    publishSpy = jest.spyOn(mockPubSub, 'publish');
    channel = new PubSubDirectChannel(mockPubSub, PEER_ID, OTHER_PEER_ID);
  });

  afterEach(async () => {
    await channel.close();
  });

  describe('publish', () => {
    it('should send message to correct topic', async () => {
      expect.assertions(1);
      const options = {};
      await channel.publish(DATA, options);
      expect(publishSpy).toHaveBeenCalledWith(TOPIC, DATA, options);
    });
  });

  describe('start', () => {
    it('should subscribe to topic and wait for peer', async () => {
      expect.assertions(6);

      const handler = jest.fn<MessageHandler<PeerMessage<Uint8Array, MockPeer>>>();
      mockPubSub.subscriberMap.set(TOPIC, [PEER_ID, OTHER_PEER_ID]);
      expect(channel.started).toBe(false);

      await channel.start({ handler });

      expect(mockPubSub.subscriberMap.has(TOPIC)).toBe(true);
      expect(mockPubSub.topicHandlers.get(TOPIC)).toBe(channel['onMessage']);
      expect(mockPubSub.topicValidators.get(TOPIC)).toBe(channel['validateMessage']);
      expect(channel.started).toBe(true);
      expect(channel['handler']).toBe(handler);
    });

    it('should do nothing if already started', async () => {
      expect.assertions(2);

      channel['_started'] = true;

      await channel.start();

      expect(mockPubSub.subscriberMap.has(TOPIC)).toBe(false);
      expect(mockPubSub.topicValidators.has(TOPIC)).toBe(false);
    });
  });

  describe('close', () => {
    it('should clean up the connection', async () => {
      expect.assertions(5);
      mockPubSub.subscriberMap.set(TOPIC, [PEER_ID, OTHER_PEER_ID]);

      await channel.start();
      await channel.close();

      expect(mockPubSub.subscriberMap.has(TOPIC)).toBe(false);
      expect(mockPubSub.topicHandlers.has(TOPIC)).toBe(false);
      expect(mockPubSub.topicValidators.has(TOPIC)).toBe(false);
      expect(channel['handler']).toBeUndefined();
      expect(channel.started).toBe(false);
    });
  });

  describe('onMessage, validateMessage', () => {
    beforeEach(async () => {
      mockPubSub.subscriberMap.set(TOPIC, [PEER_ID, OTHER_PEER_ID]);
      await channel.start();
    });

    it('should dispatch valid event', () => {
      const message = {
        type: 'signed',
        topic: TOPIC,
        data: DATA,
        from: OTHER_PEER_ID,
        sequenceNumber: 0n,
        signature: new Uint8Array(),
        key: OTHER_PEER_ID.publicKey
      };

      expect(mockPubSub.topicValidators.get(TOPIC)?.(message)).toBe(MessageValidatorResult.Accept);

      const handler = jest.fn<MessageHandler<PeerMessage<Uint8Array, MockPeer>>>();
      channel['handler'] = handler;
      channel['onMessage'](message);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].data).toBe(DATA);
      expect(handler.mock.calls[0][0].from).toBe(OTHER_PEER_ID);
    });

    test.each([
      {
        type: 'signed',
        topic: TOPIC,
        data: DATA,
        from: PEER_ID,
        sequenceNumber: 0n,
        signature: new Uint8Array(),
        key: PEER_ID.publicKey
      },
      {
        type: 'signed',
        topic: 'TOPIC',
        data: DATA,
        from: OTHER_PEER_ID,
        sequenceNumber: 0n,
        signature: new Uint8Array(),
        key: OTHER_PEER_ID.publicKey
      },
      {
        type: 'unsigned',
        topic: TOPIC,
        data: DATA,
      },
    ])('should filter out invalid event', (message) => {
      expect(mockPubSub.topicValidators.get(TOPIC)?.(message)).toBe(MessageValidatorResult.Reject);
    });

    it('should call validator', async () => {
      expect.assertions(2);

      const message = {
        type: 'signed',
        topic: TOPIC,
        data: DATA,
        from: OTHER_PEER_ID,
        sequenceNumber: 0n,
        signature: new Uint8Array(),
        key: OTHER_PEER_ID.publicKey
      };

      const channel = new PubSubDirectChannel(mockPubSub, PEER_ID, OTHER_PEER_ID, {
        validator: (msg) => {
          expect(msg).toBe(message);
          return MessageValidatorResult.Ignore;
        }
      });

      await channel.start();
      expect(mockPubSub.topicValidators.get(TOPIC)?.(message)).toBe(MessageValidatorResult.Ignore);
    });
  });

});
