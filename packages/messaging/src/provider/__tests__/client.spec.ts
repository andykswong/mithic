import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { delay, dispose, SyncMessageChannel } from '@mithic/commons';
import { MessagingClient } from '../client.ts';
import { MessagingMessage, MessagingOp } from '../codec.ts';
import { MessagingError, MessagingErrorType, type Message } from '../../types.ts';

const TOPIC = 'topic';
const TOPIC2 = 'topic2';
const TIMEOUT = 1234;

describe(MessagingClient.name, () => {
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
      expect(client.started).toBe(true);
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
      expect(messages).toEqual([{ op: MessagingOp.Message, seq, msg }])
    });

    it('throws if receiving error from host side', () => {
      const seq = client['seq'];
      host.send({ op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Unauthorized } });
      expect(() => client.send(msg))
        .toThrowError(new MessagingError({ tag: MessagingErrorType.Unauthorized }));
    });

    describe('request', () => {
      it('should send message as request with default options', async () => {
        const seq = client['seq'];
        host.send({ op: MessagingOp.Response, seq, msgs: [reply] });
        expect(client.request(msg)).toEqual([reply]);
        await delay(10);
        expect(messages).toEqual([{ op: MessagingOp.Message, seq, msg, timeoutMs: TIMEOUT, expectedReplies: 1 }])
      });

      it('should send message as request with options', async () => {
        const seq = client['seq'];
        const timeoutMs = 1337, expectedReplies = 2;
        host.send({ op: MessagingOp.Response, seq, msgs: [reply] });
        expect(client.request(msg, { timeoutMs, expectedReplies })).toEqual([reply]);
        await delay(10);
        expect(messages).toEqual([{ op: MessagingOp.Message, seq, msg, timeoutMs, expectedReplies }])
      });
    });

    describe('reply', () => {
      it('should send message as reply', async () => {
        const seq = client['seq'];
        host.send({ op: MessagingOp.Response, seq });
        client.reply(msg, reply);
        await delay(10);
        expect(messages).toEqual([{ op: MessagingOp.Message, seq, msg: reply, replyTo: msg }])
      });
    });
  });

  describe('subscribe', () => {
    it('should send subscribe request', async () => {
      const seq = client['seq'];
      host.send({ op: MessagingOp.Response, seq });
      client.subscribe([TOPIC, TOPIC2]);
      await delay(10);
      expect(messages).toEqual([{ op: MessagingOp.Subscribe, seq, topics: [TOPIC, TOPIC2] }]);
    });

    it('throws if receiving error from host side', () => {
      const seq = client['seq'];
      host.send({ op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Unauthorized } });
      expect(() => client.subscribe([TOPIC, TOPIC2]))
        .toThrowError(new MessagingError({ tag: MessagingErrorType.Unauthorized }));
    });
  });

  describe('onmessage', () => {
    const msg = { topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) };

    it('should be called on message', async () => {
      const seq = client['seq'];
      const onmessageSpy = client.onmessage = jest.fn();

      host.send({ op: MessagingOp.Message, seq, msg, timeoutMs: TIMEOUT });
      await delay(100);

      expect(messages).toEqual([{ op: MessagingOp.Response, seq }]);
      expect(onmessageSpy).toHaveBeenCalledWith(msg, TIMEOUT);
    });

    it('should send error back to host', async () => {
      const seq = client['seq'];
      const onmessageSpy = client.onmessage = jest.fn();
      onmessageSpy.mockImplementationOnce(() => AbortSignal.abort().throwIfAborted());

      host.send({ op: MessagingOp.Message, seq, msg, timeoutMs: TIMEOUT });
      await delay(100);

      expect(messages).toEqual([{ op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Timeout } }]);
    });
  });
});
