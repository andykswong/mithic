import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { delay, dispose, SharedArrayBufferChannel } from '@mithic/commons';
import { MessagingReactor } from '../reactor.ts';
import { BroadcastChannelMessagingService } from '../../impl/index.ts';
import { MessagingMessage, MessagingOp } from '../codec.ts';
import { MessagingError, MessagingErrorType, type Message, type PeerId } from '../../types.ts';

const TOPIC = 'topic';
const TOPIC2 = 'topic2';
const TIMEOUT = 1234;

describe(MessagingReactor.name, () => {
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
    jest.restoreAllMocks();
  });

  it('should start automatically', () => {
    expect(reactor.started).toBe(true);
  });

  describe('addChannel', () => {
    it('should create channel', async () => {
      const channel = reactor.addChannel();
      await delay(100);
      expect([...reactor['reactor'].channels()][1].buffers).toEqual(channel);
    });
  });

  describe('removeChannel', () => {
    it('should remove channel and delete subscription state', async () => {
      const channel = reactor.addChannel();
      expect(send({ op: MessagingOp.Subscribe, seq: ++seq, topics: [TOPIC, TOPIC2] }, new SharedArrayBufferChannel(channel)))
        .toBe(true);
      await delay(100);
      expect(reactor['subscribers'].get(TOPIC)?.buffers).toEqual(channel);
      reactor.removeChannel(channel);
      await delay(100);
      expect([...reactor['reactor'].channels()].length).toBe(1);
      expect(reactor['subscriptions'].size).toBe(0);
      expect(reactor['subscribers'].size).toBe(0);
    });
  });

  describe('subscribe', () => {
    it('should subscribe client to specified topics', async () => {
      expect(send({ op: MessagingOp.Subscribe, seq: ++seq, topics: [TOPIC, TOPIC2] })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: MessagingOp.Response, seq });
      const channel = reactor['subscribers'].get(TOPIC);
      expect(channel).toBe([...reactor['reactor'].channels()][0]);
      expect(reactor['subscribers'].get(TOPIC2)).toBe(channel);
      expect(reactor['subscriptions'].get(channel!)).toEqual(new Set([TOPIC, TOPIC2]));
    });
  });

  describe('subscriber', () => {
    it('should return topic subscribers', async () => {
      const peer = 'peer' as PeerId, peer2 = 'peer2' as PeerId;
      const subscribersSpy = jest.spyOn(service, 'subscribers');
      subscribersSpy.mockReturnValueOnce([peer, peer2]);
      expect(send({ op: MessagingOp.Subscriber, seq: ++seq, topic: TOPIC })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: MessagingOp.Response, seq, peers: [peer, peer2] });
    });
  });

  describe('message', () => {
    const msg = { topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) };

    it('should send message to service', async () => {
      const messages: Message[] = [];
      service.onmessage = (msg) => { messages.push(msg); }
      service.subscribe([TOPIC]);

      expect(send({ op: MessagingOp.Message, seq: ++seq, msg })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: MessagingOp.Response, seq });
      expect(messages).toEqual([msg]);
    });

    it('should forward service error to client', async () => {
      const sendSpy = jest.spyOn(service, 'send');
      sendSpy.mockImplementation(() => { throw new MessagingError({ tag: MessagingErrorType.Unauthorized }); });

      expect(send({ op: MessagingOp.Message, seq: ++seq, msg })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Unauthorized } });
    });

    it('should translate AbortError to timeout', async () => {
      const sendSpy = jest.spyOn(service, 'send');
      sendSpy.mockImplementation(() => { AbortSignal.abort().throwIfAborted(); });

      expect(send({ op: MessagingOp.Message, seq: ++seq, msg })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: MessagingOp.Response, seq, error: { tag: MessagingErrorType.Timeout } });
    });

    describe('request', () => {
      it('should send request to service', async () => {
        const reply = { topic: TOPIC, metadata: [], data: new Uint8Array([4]) };
        const reply2 = { topic: TOPIC, metadata: [], data: new Uint8Array([5]) };

        const requestSpy = jest.spyOn(service, 'request');
        requestSpy.mockImplementation(async () => [reply, reply2]);

        expect(send({ op: MessagingOp.Message, seq: ++seq, msg, expectedReplies: 2, timeoutMs: TIMEOUT })).toBe(true);
        await delay(100);
        expect(receive()).toEqual({ op: MessagingOp.Response, seq, msgs: [reply, reply2] });
        expect(requestSpy).toHaveBeenCalledWith(msg, { expectedReplies: 2, timeoutMs: TIMEOUT });
      });
    });

    describe('request', () => {
      it('should send reply to service', async () => {
        const replyTo = { topic: TOPIC, metadata: [], data: new Uint8Array([4]) };

        const replySpy = jest.spyOn(service, 'reply');
        replySpy.mockImplementation(() => Promise.resolve());

        expect(send({ op: MessagingOp.Message, seq: ++seq, msg, replyTo })).toBe(true);
        await delay(100);
        expect(receive()).toEqual({ op: MessagingOp.Response, seq });
        expect(replySpy).toHaveBeenCalledWith(replyTo, msg);
      });
    });
  });

  describe('onmessage', () => {
    const msg = { topic: TOPIC, metadata: [], data: new Uint8Array([1, 2, 3]) };

    it('should send message to client and wait for reply', async () => {
      const onmessageSpy = service.onmessage = jest.fn(reactor['onmessage']);
      expect(send({ op: MessagingOp.Subscribe, seq: ++seq, topics: [TOPIC] })).toBe(true);
      await delay(100);
      expect(receive()).toEqual({ op: MessagingOp.Response, seq });
      service.send(msg);
      await delay(100);
      expect(receive()).toEqual({ op: MessagingOp.Message, seq: 0, msg });
      expect(send({ op: MessagingOp.Response, seq: 0 }))
        .toBe(true);
      await delay(100);
      await expect(onmessageSpy.mock.results[0].value).resolves.toBeUndefined();
    });

    it('should rethrow error from client handler', async () => {
      const onmessageSpy = service.onmessage = jest.fn(reactor['onmessage']);
      expect(send({ op: MessagingOp.Subscribe, seq: ++seq, topics: [TOPIC] })).toBe(true);
      await delay(100);
      service.send(msg);
      await delay(100);
      receive()
      expect(receive()).toEqual({ op: MessagingOp.Message, seq: 0, msg });
      expect(send({ op: MessagingOp.Response, seq: 0, error: { tag: MessagingErrorType.Abandoned, val: MessagingErrorType.Abandoned } }))
        .toBe(true);
      await delay(100);
      await expect(onmessageSpy.mock.results[0].value)
        .rejects.toThrowError(new MessagingError({ tag: MessagingErrorType.Abandoned, val: MessagingErrorType.Abandoned }));
    });
  });

  function send(msg: MessagingMessage, c = client) {
    return c.send(MessagingMessage.encode(msg));
  }

  function receive(c = client) {
    return MessagingMessage.decode(c.receive() || new Uint8Array());
  }
});
