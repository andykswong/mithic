import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { StringMatcher } from '@mithic/commons';
import { MessagingError, MessagingErrorType, type MessageHandler, type PeerId } from '../types.ts';
import { createMessage, createMockMessagingService } from '../test/mocks.ts';
import { RoutingMessagingService } from './index.ts';

const TOPIC = 'test';
const UNSUPPORTED_ERR = new MessagingError({ tag: MessagingErrorType.Other, val: 'unsupported' });

describe('RoutingMessagingService', () => {
  let service: RoutingMessagingService;

  beforeEach(() => {
    service = new RoutingMessagingService();
    service.route(StringMatcher.matchExact('wrongTopic'), createMockMessagingService());
  });

  describe('send', () => {
    it('should send message to the correct messaging service', () => {
      const mockService1 = createMockMessagingService();
      const mockService2 = createMockMessagingService();
      service.route(StringMatcher.matchExact(TOPIC), mockService1);
      service.route(/^test.*$/, mockService2);

      const msg = createMessage();
      service.send(TOPIC, msg);

      assert.strictEqual(mockService2.send.mock.callCount(), 0);
      assert.strictEqual(mockService1.send.mock.callCount(), 1);
      assert.deepStrictEqual(mockService1.send.mock.calls[0].arguments, [TOPIC, msg]);
    });

    it('should throw an error if there is no matched messaging service', () => {
      const msg = createMessage();
      assert.throws(() => service.send(TOPIC, msg), UNSUPPORTED_ERR);
    });
  });

  describe('subscribe', () => {
    it('should subscribe to the correct messaging service', () => {
      const mockService1 = createMockMessagingService();
      const mockService2 = createMockMessagingService();
      service.route(StringMatcher.matchExact(TOPIC), mockService1);
      service.route(/^test.*$/, mockService2);

      const service2Topics = ['testing', 'tests'];

      const handler: MessageHandler = { handle() { } };
      service.subscribe([...service2Topics, TOPIC, 'not match'], handler);

      assert.strictEqual(mockService1.subscribe.mock.callCount(), 1);
      assert.deepStrictEqual(mockService1.subscribe.mock.calls[0].arguments, [[TOPIC], handler]);
      assert.strictEqual(mockService2.subscribe.mock.callCount(), 1);
      assert.deepStrictEqual(mockService2.subscribe.mock.calls[0].arguments, [service2Topics, handler]);
    });
  });

  describe('request', () => {
    it('should request to the correct messaging service', () => {
      const mockService1 = createMockMessagingService();
      const mockService2 = createMockMessagingService();
      service.route(StringMatcher.matchExact(TOPIC), mockService1);
      service.route(/^test.*$/, mockService2);

      const expectedReplies = [createMessage('reply')];
      mockService1.request?.mock.mockImplementationOnce(() => expectedReplies);

      const msg = createMessage();
      const options = { timeoutMs: 1000, expectedReplies: 2 };
      const replies = service.request(TOPIC, msg, options);

      assert.deepStrictEqual(replies, expectedReplies);
      assert.strictEqual(mockService2.request?.mock.callCount(), 0);
      assert.strictEqual(mockService1.request?.mock.callCount(), 1);
      assert.deepStrictEqual(mockService1.request.mock.calls[0].arguments, [TOPIC, msg, options]);
    });

    it('should throw an error if there is no matched messaging service', () => {
      const msg = createMessage();
      assert.throws(() => { service.request(TOPIC, msg); }, UNSUPPORTED_ERR);
    });
  });

  describe('reply', () => {
    it('should reply to the correct messaging service', () => {
      const mockService1 = createMockMessagingService();
      const mockService2 = createMockMessagingService();
      service.route(StringMatcher.matchExact(TOPIC), mockService1);
      service.route(/^test.*$/, mockService2);

      const request = createMessage(TOPIC);
      const reply = createMessage('reply');
      service.reply(request, reply);

      assert.strictEqual(mockService2.reply?.mock.callCount(), 0);
      assert.strictEqual(mockService1.reply?.mock.callCount(), 1);
      assert.deepStrictEqual(mockService1.reply.mock.calls[0].arguments, [request, reply]);
    });

    it('should throw an error if there is no matched messaging service', () => {
      const msg = createMessage(TOPIC);
      const reply = createMessage('reply');
      assert.throws(() => { service.reply(msg, reply); }, UNSUPPORTED_ERR);
    });
  });

  describe('listSubscribers', () => {
    it('should list subscribers from the correct messaging service', () => {
      const mockService1 = createMockMessagingService();
      const mockService2 = createMockMessagingService();
      service.route(StringMatcher.matchExact(TOPIC), mockService1);
      service.route(/^test.*$/, mockService2);

      const expectedSubscribers = ['sub1', 'sub2'] as PeerId[];
      mockService1.listSubscribers?.mock.mockImplementationOnce(() => expectedSubscribers);

      const subscribers = service.listSubscribers(TOPIC);

      assert.deepStrictEqual(subscribers, expectedSubscribers);
      assert.strictEqual(mockService2.listSubscribers?.mock.callCount(), 0);
      assert.strictEqual(mockService1.listSubscribers?.mock.callCount(), 1);
      assert.deepStrictEqual(mockService1.listSubscribers.mock.calls[0].arguments, [TOPIC]);
    });

    it('should throw an error if there is no matched messaging service', () => {
      assert.throws(() => { service.listSubscribers(TOPIC); }, UNSUPPORTED_ERR);
    });
  });
});
