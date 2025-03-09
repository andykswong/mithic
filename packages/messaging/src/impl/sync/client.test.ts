import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { delay, dispose, SyncMessageChannel } from '@mithic/commons';
import { Message } from '../../message.ts';
import { MessagingError, MessagingErrorType, type MessageHandler } from '../../types.ts';
import { MessagingMessage, MessagingOp } from './codec.ts';
import { MessagingClient } from './index.ts';

const TOPIC = 'topic';
const TOPIC2 = 'topic2';
const TIMEOUT = 1234;

describe('MessagingClient', () => {
  let client: MessagingClient;
  let host: SyncMessageChannel<MessagingMessage>;
  let messages: MessagingMessage[];

  beforeEach(() => {
    client = new MessagingClient({ timeoutMs: TIMEOUT });
    messages = [];
    host = new SyncMessageChannel({
      codec: MessagingMessage,
      receiver: true,
      onmessage(message) {
        messages.push(message);
      },
      ...client.channel
    });
  });

  afterEach(() => {
    dispose(client);
    dispose(host);
  });

  describe('constructor', () => {
    it('should start automatically', () => {
      assert.strictEqual(client.started, true);
    });
  });

  describe('send', () => {
    const msg = Message.from({ metadata: [], data: new Uint8Array([1, 2, 3]) });
    const reply = Message.from({ topic: TOPIC, metadata: [['reply', '123']], data: new Uint8Array([4, 5]) });

    it('should send message', async () => {
      const seq = client['seq'];
      host.send({ op: MessagingOp.Response, seq });
      client.send(TOPIC, msg);
      await delay(10);
      assert.deepStrictEqual(messages, [{ op: MessagingOp.Message, seq, topic: TOPIC, msg: msg.toRecord(), replyTo: undefined }]);
    });

    it('throws if receiving error from host side', () => {
      const error = { tag: MessagingErrorType.PermissionDenied, val: 'test' };
      const seq = client['seq'];
      host.send({ op: MessagingOp.Response, seq, error });
      assert.throws(() => client.send(TOPIC, msg), new MessagingError(error));
    });

    describe('request', () => {
      it('should send message as request with default options', async () => {
        const seq = client['seq'];
        host.send({ op: MessagingOp.Response, seq, msgs: [reply.toRecord()] });
        assert.deepStrictEqual(client.request(TOPIC, msg), [reply]);
        await delay(10);
        assert.deepStrictEqual(messages, [{ op: MessagingOp.Message, seq, topic: TOPIC, msg: msg.toRecord(), timeoutMs: TIMEOUT, expectedReplies: 1, replyTo: undefined }]);
      });

      it('should send message as request with options', async () => {
        const seq = client['seq'];
        const timeoutMs = 1337, expectedReplies = 2;
        host.send({ op: MessagingOp.Response, seq, msgs: [reply.toRecord()] });
        assert.deepStrictEqual(client.request(TOPIC, msg, { timeoutMs, expectedReplies }), [reply]);
        await delay(10);
        assert.deepStrictEqual(messages, [{ op: MessagingOp.Message, seq, topic: TOPIC, msg: msg.toRecord(), timeoutMs, expectedReplies, replyTo: undefined }]);
      });
    });

    describe('reply', () => {
      it('should send message as reply', async () => {
        const seq = client['seq'];
        host.send({ op: MessagingOp.Response, seq });
        client.reply(msg, reply);
        await delay(10);
        assert.deepStrictEqual(messages, [{ op: MessagingOp.Message, seq, topic: '', msg: reply.toRecord(), replyTo: msg.toRecord() }]);
      });
    });
  });

  describe('subscribe', () => {
    it('should send subscribe request', async () => {
      const seq = client['seq'];
      const handle = client['handlerSeq'];
      const handler = createHandler();
      host.send({ op: MessagingOp.Response, seq });
      client.subscribe([TOPIC, TOPIC2], handler);
      await delay(10);
      assert.deepStrictEqual(messages, [{ op: MessagingOp.Subscribe, seq, handle, topics: [TOPIC, TOPIC2] }]);
      assert.strictEqual(client['handlerIds'].get(handler), handle);
      assert.strictEqual(client['handlers'].get(handle)?.deref(), handler);
    });

    it('throws if receiving error from host side', () => {
      const error = { tag: MessagingErrorType.PermissionDenied, val: 'test' };
      const seq = client['seq'];
      host.send({ op: MessagingOp.Response, seq, error });
      assert.throws(() => client.subscribe([TOPIC, TOPIC2], createHandler()), new MessagingError(error));
    });

    describe('handler', () => {
      const msg = Message.from({ topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) });
      const handle = 1;
      let seq = 0;
      let handler: ReturnType<typeof createHandler>;

      beforeEach(() => {
        seq = client['seq'];
        handler = createHandler();
        client['handlerIds'].set(handler, handle);
        client['handlers'].set(handle, new WeakRef(handler));
      });

      it('should be called on message', async () => {
        host.send({ op: MessagingOp.Message, seq, handle, topic: TOPIC, msg: msg.toRecord(), timeoutMs: TIMEOUT });
        await delay(100);

        assert.deepStrictEqual(messages, [{ op: MessagingOp.Response, seq }]);
        assert.strictEqual(handler.handle.mock.callCount(), 1);
        assert.deepStrictEqual(handler.handle.mock.calls[0].arguments, [msg]);
      });

      it('should send error back to host', async () => {
        handler.handle.mock.mockImplementationOnce(() => AbortSignal.abort().throwIfAborted());
        host.send({ op: MessagingOp.Message, seq, handle, topic: TOPIC, msg: msg.toRecord(), timeoutMs: TIMEOUT });
        await delay(100);

        assert.deepStrictEqual(messages, [{ op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Timeout } }]);
      });
    });

    function createHandler() {
      return { handle: mock.fn() } satisfies MessageHandler;
    }
  });
});
