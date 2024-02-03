import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DirectMessageBus, PUBSUB_DIRECT_CHANNEL_PROTOCOL_NAME, PUBSUB_DIRECT_CHANNEL_PROTOCOL_SEMVER } from '../direct.ts';
import { MockPeer, MockMessageBus } from '../../__tests__/mocks.ts';
import { MessageValidationError, MessageValidationErrorCode } from '../../error.ts';

const PEER_ID = new MockPeer(new Uint8Array([6, 6, 6]));
const OTHER_PEER_ID = new MockPeer(new Uint8Array([7, 7, 7]));
const PEER_ID_2 = new MockPeer(new Uint8Array([7, 7, 5]));
const TOPIC = `/${PUBSUB_DIRECT_CHANNEL_PROTOCOL_NAME}/${PUBSUB_DIRECT_CHANNEL_PROTOCOL_SEMVER}/${PEER_ID}/${OTHER_PEER_ID}`;
const DATA = new Uint8Array([1, 2, 3]);
const TOPIC2 = 'test';
const FULL_TOPIC2 = `${TOPIC}/${TOPIC2}`;

describe(DirectMessageBus.name, () => {
  let bus: DirectMessageBus<Uint8Array, MockPeer>;
  let mockBus: MockMessageBus;
  let dispatchSpy: jest.SpiedFunction<MockMessageBus['dispatch']>;

  beforeEach(() => {
    mockBus = new MockMessageBus();
    dispatchSpy = jest.spyOn(mockBus, 'dispatch');
    bus = new DirectMessageBus(mockBus, PEER_ID, OTHER_PEER_ID);
  });

  describe('getFullTopic', () => {
    it('should return full topic for given topic', () => {
      expect(bus.getFullTopic(TOPIC2)).toBe(FULL_TOPIC2);
    });
  });

  describe('resolveTopic', () => {
    it('should return local topic for given full topic', () => {
      expect(bus.resolveTopic(FULL_TOPIC2)).toBe(TOPIC2);
      expect(bus.resolveTopic(TOPIC)).toBe('');
      expect(bus.resolveTopic('123')).toBe(undefined);
    });
  });

  describe('publish', () => {
    it('should send message to correct topic', async () => {
      await bus.dispatch(DATA);
      expect(dispatchSpy).toHaveBeenCalledWith(DATA, { topic: TOPIC });
    });
  });

  describe('subscribe', () => {
    it('should subscribe to `id` topic by default', () => {
      const callback = jest.fn(() => undefined);
      bus.subscribe(callback);
      expect(mockBus.topicHandlers.get(TOPIC)).toBeDefined();
      mockBus.topicHandlers.get(TOPIC)?.(DATA, { topic: TOPIC, from: OTHER_PEER_ID });
      expect(callback).toHaveBeenCalledWith(DATA, { topic: '', from: OTHER_PEER_ID });
    });

    it('should subscribe to the correct topic', () => {
      const callback = jest.fn(() => undefined);
      bus.subscribe(callback, { topic: TOPIC2 });
      expect(mockBus.topicHandlers.get(FULL_TOPIC2)).toBeDefined();
      mockBus.topicHandlers.get(FULL_TOPIC2)?.(DATA, { topic: FULL_TOPIC2, from: OTHER_PEER_ID });
      expect(callback).toHaveBeenCalledWith(DATA, { topic: TOPIC2, from: OTHER_PEER_ID });
    });

    it('should ignore message from unrecognized peer', () => {
      const callback = jest.fn(() => undefined);
      bus.subscribe(callback);
      expect(mockBus.topicValidators.get(TOPIC)?.(DATA, { topic: TOPIC, from: PEER_ID_2 }))
        .toEqual(new MessageValidationError('invalid message', { code: MessageValidationErrorCode.Ignore }));
    });

    it('should ignore message from invalid topic ID', () => {
      const callback = jest.fn(() => undefined);
      bus.subscribe(callback);
      expect(mockBus.topicValidators.get(TOPIC)?.(DATA, { topic: FULL_TOPIC2, from: OTHER_PEER_ID }))
        .toEqual(new MessageValidationError('invalid message', { code: MessageValidationErrorCode.Ignore }));
    });

    it('should use given validator to validate messages before passing to handler', () => {
      const callback = jest.fn(() => undefined);
      bus.subscribe(callback, { validator: () => new MessageValidationError() });
      expect(mockBus.topicValidators.get(TOPIC)?.(DATA, { topic: TOPIC, from: OTHER_PEER_ID }))
        .toEqual(new MessageValidationError());
    });

    it('should return a function that unsubscribes handler from underlying event dispatcher', async () => {
      const callback = jest.fn(() => undefined);
      const subscription = await bus.subscribe(callback, { topic: TOPIC });
      subscription();
      mockBus.topicHandlers.get(TOPIC)?.(DATA, { topic: TOPIC, from: OTHER_PEER_ID });
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
