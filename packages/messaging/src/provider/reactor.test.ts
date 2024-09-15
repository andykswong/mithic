import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { delay, dispose, SharedArrayBufferChannel } from '@mithic/commons';
import { BroadcastChannelMessagingService } from '../impl/index.ts';
import { MessagingError, MessagingErrorType, type Message, type PeerId } from '../types.ts';
import { MessagingReactor } from './index.ts';
import { MessagingMessage, MessagingOp } from './codec.ts';

const TOPIC = 'topic';
const TOPIC2 = 'topic2';
const TIMEOUT = 1234;

describe('MessagingReactor', () => {
  let reactor: MessagingReactor;
  let client: SharedArrayBufferChannel;
  let service: BroadcastChannelMessagingService;
  let seq = 0;

  beforeEach(async () => {
    service = new BroadcastChannelMessagingService();
    client = new SharedArrayBufferChannel();
    reactor = new MessagingReactor({ service, ...client.buffers });
  });

  afterEach(async () => {
    dispose(reactor);
    dispose(service);
  });

  it('should start automatically', () => {
    assert.strictEqual(reactor.started, true);
  });

  describe('addChannel', () => {
    it('should create channel', async () => {
      const channel = reactor.addChannel();
      await delay(100);
      assert.deepStrictEqual([...reactor['reactor'].channels()][1].buffers, channel);
    });
  });

  describe('removeChannel', () => {
    it('should remove channel and delete subscription state', async () => {
      const channel = reactor.addChannel();
      assert(send({ op: MessagingOp.Subscribe, seq: ++seq, topics: [TOPIC, TOPIC2] }, new SharedArrayBufferChannel(channel)));
      await delay(100);
      assert.deepStrictEqual(reactor['subscribers'].get(TOPIC)?.buffers, channel);
      reactor.removeChannel(channel);
      await delay(100);
      assert.strictEqual([...reactor['reactor'].channels()].length, 1);
      assert.strictEqual(reactor['subscriptions'].size, 0);
      assert.strictEqual(reactor['subscribers'].size, 0);
    });
  });

  describe('subscribe', () => {
    it('should subscribe client to specified topics', async () => {
      assert.strictEqual(send({ op: MessagingOp.Subscribe, seq: ++seq, topics: [TOPIC, TOPIC2] }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq });
      const channel = reactor['subscribers'].get(TOPIC);
      assert.strictEqual(channel, [...reactor['reactor'].channels()][0]);
      assert.strictEqual(reactor['subscribers'].get(TOPIC2), channel);
      assert.deepStrictEqual(reactor['subscriptions'].get(channel!), new Set([TOPIC, TOPIC2]));
    });
  });

  describe('subscriber', () => {
    it('should return topic subscribers', async () => {
      const peer = 'peer' as PeerId, peer2 = 'peer2' as PeerId;
      const subscribersSpy = mock.method(service, 'subscribers');
      subscribersSpy.mock.mockImplementationOnce(() => [peer, peer2]);
      assert.strictEqual(send({ op: MessagingOp.Subscriber, seq: ++seq, topic: TOPIC }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq, peers: [peer, peer2] });
    });
  });

  describe('message', () => {
    const msg = { topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) };

    it('should send message to service', async () => {
      const messages: Message[] = [];
      service.onmessage = (msg) => { messages.push(msg); }
      service.subscribe([TOPIC]);

      assert.strictEqual(send({ op: MessagingOp.Message, seq: ++seq, msg }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq });
      assert.deepStrictEqual(messages, [msg]);
    });

    it('should forward service error to client', async () => {
      const sendSpy = mock.method(service, 'send');
      sendSpy.mock.mockImplementation(() => { throw new MessagingError({ tag: MessagingErrorType.Unauthorized }); });

      assert.strictEqual(send({ op: MessagingOp.Message, seq: ++seq, msg }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Unauthorized } });
    });

    it('should translate AbortError to timeout', async () => {
      const sendSpy = mock.method(service, 'send');
      sendSpy.mock.mockImplementation(() => { AbortSignal.abort().throwIfAborted(); });

      assert.strictEqual(send({ op: MessagingOp.Message, seq: ++seq, msg }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Timeout } });
    });

    describe('request', () => {
      it('should send request to service', async () => {
        const reply = { topic: TOPIC, metadata: [], data: new Uint8Array([4]) };
        const reply2 = { topic: TOPIC, metadata: [], data: new Uint8Array([5]) };

        const requestSpy = mock.method(service, 'request');
        requestSpy.mock.mockImplementation(async () => [reply, reply2]);

        assert.strictEqual(send({ op: MessagingOp.Message, seq: ++seq, msg, expectedReplies: 2, timeoutMs: TIMEOUT }), true);
        await delay(100);
        assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq, msgs: [reply, reply2] });
        assert.deepStrictEqual(requestSpy.mock.calls[0].arguments, [msg, { expectedReplies: 2, timeoutMs: TIMEOUT }]);
      });
    });

    describe('reply', () => {
      it('should send reply to service', async () => {
        const replyTo = { topic: TOPIC, metadata: [], data: new Uint8Array([4]) };

        const replySpy = mock.method(service, 'reply');
        replySpy.mock.mockImplementation(() => Promise.resolve());

        assert.strictEqual(send({ op: MessagingOp.Message, seq: ++seq, msg, replyTo }), true);
        await delay(100);
        assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq });
        assert.deepStrictEqual(replySpy.mock.calls[0].arguments, [replyTo, msg]);
      });
    });
  });

  describe('onmessage', () => {
    const msg = { topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) };

    it('should send message to client and wait for reply', async () => {
      const onmessageSpy = service.onmessage = mock.fn(reactor['onmessage']);
      assert.strictEqual(send({ op: MessagingOp.Subscribe, seq: ++seq, topics: [TOPIC] }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq });
      service.send(msg);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: MessagingOp.Message, seq: 0, msg, timeoutMs: undefined });
      assert(send({ op: MessagingOp.Response, seq: 0 }));
      await delay(100);
      assert.strictEqual(await onmessageSpy.mock.calls[0].result, undefined);
    });

    it('should rethrow error from client handler', async () => {
      const onmessageSpy = service.onmessage = mock.fn(reactor['onmessage']);
      assert.strictEqual(send({ op: MessagingOp.Subscribe, seq: ++seq, topics: [TOPIC] }), true);
      await delay(100);
      service.send(msg);
      await delay(100);
      receive()
      assert.deepStrictEqual(receive(), { op: MessagingOp.Message, seq: 0, msg, timeoutMs: undefined });
      assert(send({ op: MessagingOp.Response, seq: 0, error: { tag: MessagingErrorType.Abandoned, val: MessagingErrorType.Abandoned } }));
      await delay(100);
      assert.rejects(
        async () => { await onmessageSpy.mock.calls[0].result; },
        new MessagingError({ tag: MessagingErrorType.Abandoned, val: MessagingErrorType.Abandoned })
      );
    });
  });

  function send(msg: MessagingMessage, c = client) {
    return c.send(MessagingMessage.encode(msg));
  }

  function receive(c = client) {
    return MessagingMessage.decode(c.receive() || new Uint8Array());
  }
});
