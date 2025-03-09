import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { delay, dispose, SharedArrayBufferChannel } from '@mithic/commons';
import { Message } from '../../message.ts';
import { MessagingError, MessagingErrorType, type PeerId } from '../../types.ts';
import { MessagingMessage, MessagingOp } from './codec.ts';
import { MessagingReactor } from './index.ts';
import { createMockMessagingService, type MockMessagingService } from '../../test/mocks.ts';

const TIMEOUT_MS = 299;
const TOPIC = 'topic';
const TOPIC2 = 'topic2';
const TIMEOUT = 1234;

describe('MessagingReactor', () => {
  let reactor: MessagingReactor;
  let client: SharedArrayBufferChannel;
  let service: MockMessagingService;
  let seq = 0;

  beforeEach(async () => {
    service = createMockMessagingService();
    client = new SharedArrayBufferChannel();
    reactor = new MessagingReactor({ service, ...client.buffers, handlerTimeoutMs: TIMEOUT_MS });
  });

  afterEach(() => {
    dispose(reactor);
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
      const handle = 1;
      const channel = reactor.addChannel();
      const syncMessageChannel = [...reactor['reactor'].channels()][1];
      assert(send({ op: MessagingOp.Subscribe, seq: ++seq, handle, topics: [TOPIC, TOPIC2] }, new SharedArrayBufferChannel(channel)));
      await delay(100);
      assert.strictEqual(reactor['subscriptions'].get(syncMessageChannel)?.has(handle), true);
      reactor.removeChannel(channel);
      await delay(100);
      assert.strictEqual([...reactor['reactor'].channels()].length, 1);
      assert.strictEqual(reactor['subscriptions'].size, 0);
    });
  });

  describe('client message', () => {
    const msg = Message.from({ data: new Uint8Array([1, 2, 3]), metadata: [] });

    describe('message', () => {
      it('should send message to service', async () => {
        assert.strictEqual(send({ op: MessagingOp.Message, seq: ++seq, topic: TOPIC, msg: msg.toRecord() }), true);
        await delay(100);
        assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq });
        assert.strictEqual(service.send.mock.callCount(), 1);
        assert.deepStrictEqual(service.send.mock.calls[0].arguments, [TOPIC, msg]);
      });

      it('should forward service error to client', async () => {
        const error = { tag: MessagingErrorType.PermissionDenied, val: 'err' };
        service.send.mock.mockImplementation(() => { throw new MessagingError(error); });

        assert.strictEqual(send({ op: MessagingOp.Message, seq: ++seq, topic: TOPIC, msg: msg.toRecord() }), true);
        await delay(100);
        assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq, error });
      });

      it('should translate AbortError to timeout', async () => {
        const sendSpy = mock.method(service, 'send');
        sendSpy.mock.mockImplementation(() => { AbortSignal.abort().throwIfAborted(); });

        assert.strictEqual(send({ op: MessagingOp.Message, seq: ++seq, topic: TOPIC, msg: msg.toRecord() }), true);
        await delay(100);
        assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Timeout } });
      });
    });

    describe('subscribe', () => {
      it('should subscribe client to specified topics', async () => {
        const handle = 1;
        assert.strictEqual(send({ op: MessagingOp.Subscribe, seq: ++seq, handle, topics: [TOPIC, TOPIC2] }), true);
        await delay(100);
        assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq });
        const syncMessageChannel = [...reactor['reactor'].channels()][0];
        const handler = reactor['subscriptions'].get(syncMessageChannel)?.get(handle);
        assert.strictEqual(!!handler, true);
        assert.strictEqual(service.subscribe.mock.callCount(), 1);
        assert.deepStrictEqual(service.subscribe.mock.calls[0].arguments, [[TOPIC, TOPIC2], handler]);
      });
    });

    describe('subscriber', () => {
      it('should return topic subscribers', async () => {
        const peer = 'peer' as PeerId, peer2 = 'peer2' as PeerId;
        service.listSubscribers?.mock.mockImplementationOnce(() => [peer, peer2]);
        assert.strictEqual(send({ op: MessagingOp.Subscriber, seq: ++seq, topic: TOPIC }), true);
        await delay(100);
        assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq, peers: [peer, peer2] });
      });
    });

    describe('request', () => {
      it('should send request to service', async () => {
        const reply = Message.from({ topic: TOPIC, metadata: [], data: new Uint8Array([4]) });
        const reply2 = Message.from({ topic: TOPIC, metadata: [], data: new Uint8Array([5]) });
        const options = { expectedReplies: 2, timeoutMs: TIMEOUT };

        service.request?.mock.mockImplementation(async () => [reply, reply2]);

        assert.strictEqual(send({ op: MessagingOp.Message, seq: ++seq, topic: TOPIC, msg: msg.toRecord(), ...options }), true);
        await delay(100);
        assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq, msgs: [reply.toRecord(), reply2.toRecord()] });
        assert.strictEqual(service.request?.mock.callCount(), 1);
        assert.deepStrictEqual(service.request?.mock.calls[0].arguments, [TOPIC, msg, options]);
      });
    });

    describe('reply', () => {
      it('should send reply to service', async () => {
        const replyTo = Message.from({ topic: TOPIC, metadata: [], data: new Uint8Array([4]) });

        service.reply?.mock.mockImplementation(() => Promise.resolve());

        assert.strictEqual(send({ op: MessagingOp.Message, seq: ++seq, topic: TOPIC, msg: msg.toRecord(), replyTo: replyTo.toRecord() }), true);
        await delay(100);
        assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq });
        assert.strictEqual(service.reply?.mock.callCount(), 1);
        assert.deepStrictEqual(service.reply?.mock.calls[0].arguments, [replyTo, msg]);
      });
    });
  });

  describe('server message', () => {
    const msg = Message.from({ topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) });
    const handle = 1;

    it('should send message to client and wait for reply', async () => {
      assert.strictEqual(send({ op: MessagingOp.Subscribe, seq: ++seq, handle, topics: [TOPIC] }), true);
      await delay(100);
      assert.deepStrictEqual(receive(), { op: MessagingOp.Response, seq });

      const handleResult = sendServerMessage(msg);
      await delay(100);

      assert.deepStrictEqual(receive(), { op: MessagingOp.Message, seq: 0, handle, topic: TOPIC, msg: msg.toRecord(), timeoutMs: TIMEOUT_MS });
      assert(send({ op: MessagingOp.Response, seq: 0 }));
      await handleResult;
    });

    it('should rethrow error from client handler', async () => {
      assert.strictEqual(send({ op: MessagingOp.Subscribe, seq: ++seq, handle, topics: [TOPIC] }), true);
      await delay(100);

      const handleResult = sendServerMessage(msg);
      await delay(100);

      receive();
      assert.deepStrictEqual(receive(), { op: MessagingOp.Message, seq: 0, handle, topic: TOPIC, msg: msg.toRecord(), timeoutMs: TIMEOUT_MS });
      assert(send({ op: MessagingOp.Response, seq: 0, error: { tag: MessagingErrorType.PermissionDenied, val: MessagingErrorType.PermissionDenied } }));

      await assert.rejects(
        async () => { await handleResult; },
        new MessagingError({ tag: MessagingErrorType.PermissionDenied, val: MessagingErrorType.PermissionDenied })
      );
    });

    it('should throw timeout error when timeout', async () => {
      assert.strictEqual(send({ op: MessagingOp.Subscribe, seq: ++seq, handle, topics: [TOPIC] }), true);
      await delay(100);

      const handleResult = sendServerMessage(msg);
      await delay(100);

      receive();
      assert.deepStrictEqual(receive(), { op: MessagingOp.Message, seq: 0, handle, topic: TOPIC, msg: msg.toRecord(), timeoutMs: TIMEOUT_MS });

      await assert.rejects(
        async () => { await handleResult; },
        new MessagingError({ tag: MessagingErrorType.Timeout })
      );
    });

    function sendServerMessage(msg: Message) {
      assert.strictEqual(service.subscribe.mock.callCount(), 1);
      assert.deepStrictEqual(service.subscribe.mock.calls[0].arguments[0], [TOPIC]);
      const handler = service.subscribe.mock.calls[0].arguments[1];
      return handler.handle(msg);
    }
  });

  function send(msg: MessagingMessage, c = client) {
    return c.send(MessagingMessage.encode(msg));
  }

  function receive(c = client) {
    return MessagingMessage.decode(c.receive() || new Uint8Array());
  }
});
