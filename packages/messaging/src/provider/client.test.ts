import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { delay, dispose, SyncMessageChannel } from '@mithic/commons';
import { MessagingError, MessagingErrorType, type Message } from '../types.ts';
import { MessagingClient } from './index.ts';
import { MessagingMessage, MessagingOp } from './codec.ts';

const TOPIC = 'topic';
const TOPIC2 = 'topic2';
const TIMEOUT = 1234;

describe('MessagingClient', () => {
  let client: MessagingClient;
  let host: SyncMessageChannel<MessagingMessage>;
  let messages: MessagingMessage[];

  beforeEach(async () => {
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

  afterEach(async () => {
    dispose(client);
    dispose(host);
  });

  describe('constructor', () => {
    it('should start automatically', () => {
      assert.strictEqual(client.started, true);
    });
  });

  describe('send', () => {
    const msg = { topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) };
    const reply: Message = { topic: TOPIC, metadata: [['reply', '123']], data: new Uint8Array([4, 5]) };

    it('should send message', async () => {
      const seq = client['seq'];
      host.send({ op: MessagingOp.Response, seq });
      client.send(msg);
      await delay(10);
      assert.deepStrictEqual(messages, [{ op: MessagingOp.Message, seq, msg, replyTo: undefined }])
    });

    it('throws if receiving error from host side', () => {
      const seq = client['seq'];
      host.send({ op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Unauthorized } });
      assert.throws(() => client.send(msg), new MessagingError({ tag: MessagingErrorType.Unauthorized }));
    });

    describe('request', () => {
      it('should send message as request with default options', async () => {
        const seq = client['seq'];
        host.send({ op: MessagingOp.Response, seq, msgs: [reply] });
        assert.deepStrictEqual(client.request(msg), [reply]);
        await delay(10);
        assert.deepStrictEqual(messages, [{ op: MessagingOp.Message, seq, msg, timeoutMs: TIMEOUT, expectedReplies: 1, replyTo: undefined }])
      });

      it('should send message as request with options', async () => {
        const seq = client['seq'];
        const timeoutMs = 1337, expectedReplies = 2;
        host.send({ op: MessagingOp.Response, seq, msgs: [reply] });
        assert.deepStrictEqual(client.request(msg, { timeoutMs, expectedReplies }), [reply]);
        await delay(10);
        assert.deepStrictEqual(messages, [{ op: MessagingOp.Message, seq, msg, timeoutMs, expectedReplies, replyTo: undefined }])
      });
    });

    describe('reply', () => {
      it('should send message as reply', async () => {
        const seq = client['seq'];
        host.send({ op: MessagingOp.Response, seq });
        client.reply(msg, reply);
        await delay(10);
        assert.deepStrictEqual(messages, [{ op: MessagingOp.Message, seq, msg: reply, replyTo: msg }])
      });
    });
  });

  describe('subscribe', () => {
    it('should send subscribe request', async () => {
      const seq = client['seq'];
      host.send({ op: MessagingOp.Response, seq });
      client.subscribe([TOPIC, TOPIC2]);
      await delay(10);
      assert.deepStrictEqual(messages, [{ op: MessagingOp.Subscribe, seq, topics: [TOPIC, TOPIC2] }]);
    });

    it('throws if receiving error from host side', () => {
      const seq = client['seq'];
      host.send({ op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Unauthorized } });
      assert.throws(() => client.subscribe([TOPIC, TOPIC2]), new MessagingError({ tag: MessagingErrorType.Unauthorized }));
    });
  });

  describe('onmessage', () => {
    const msg = { topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) };

    it('should be called on message', async () => {
      const seq = client['seq'];
      const onmessageSpy = client.onmessage = mock.fn<NonNullable<MessagingClient['onmessage']>>();

      host.send({ op: MessagingOp.Message, seq, msg, timeoutMs: TIMEOUT });
      await delay(100);

      assert.deepStrictEqual(messages, [{ op: MessagingOp.Response, seq }]);
      assert.deepStrictEqual(onmessageSpy.mock.calls[0].arguments, [msg, TIMEOUT]);
    });

    it('should send error back to host', async () => {
      const seq = client['seq'];
      const onmessageSpy = client.onmessage = mock.fn<NonNullable<MessagingClient['onmessage']>>();
      onmessageSpy.mock.mockImplementationOnce(() => AbortSignal.abort().throwIfAborted());

      host.send({ op: MessagingOp.Message, seq, msg, timeoutMs: TIMEOUT });
      await delay(100);

      assert.deepStrictEqual(messages, [{ op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Timeout } }]);
    });
  });
});
