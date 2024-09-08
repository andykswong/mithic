import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TextCodec } from '../../codec.ts';
import { dispose } from '../../lifecycle.ts';
import { delay } from '../../async/index.ts';
import { SharedArrayBufferChannel } from '../buffer.ts';
import { SyncMessageChannel } from '../message.ts';

describe(SyncMessageChannel.name, () => {
  let channel: SyncMessageChannel<string>;
  let codec: TextCodec;
  let client: SharedArrayBufferChannel;
  let handler: jest.Mock<(message: string) => void>;

  beforeEach(() => {
    codec = new TextCodec();
    handler = jest.fn();
    channel = new SyncMessageChannel({ codec, onmessage: handler, receiver: true });
    client = new SharedArrayBufferChannel(channel.buffers);
  });

  afterEach(() => {
    dispose(channel);
  });

  it('should start by default', () => {
    expect(channel.started).toBe(true);
  });

  describe('send', () => {
    it('should send messages to channel', () => {
      const input = 'This is a message.';
      expect(channel.send(input)).toBe(true);
      const result = client.receive();
      expect(codec.decode(result!)).toBe(input);
    });
  });

  describe('sendAsync', () => {
    it('should send messages to channel', async () => {
      const input = 'This is a reply!';
      expect(await channel.sendAsync(input)).toBe(true);
      const result = client.receive();
      expect(codec.decode(result!)).toBe(input);
    });

    it('should wait for channel to be flushed', async () => {
      const garbage = new Uint8Array(channel.maxSendSize);
      channel['channel'].send(garbage);

      const input = 'This is a reply!';
      expect(await channel.sendAsync(input, 0)).toBe(false);
      const pendingSend = channel.sendAsync(input);
      client.receive();
      expect(await pendingSend).toBe(true);
    });
  });

  describe('receive', () => {
    it('should return undefined if there is no message to process', () => {
      expect(channel.receive()).toBeUndefined();
    });

    it('should return message from client', () => {
      const input = 'This is a testing.';
      expect(client.send(codec.encode(input))).toBe(true);
      expect(channel.receive()).toBe(input);
      expect(handler).toHaveBeenCalledWith(input);
    });
  });

  describe('process', () => {
    it('should return 0 if there is no message to process', () => {
      expect(channel.process()).toBe(0);
    });

    it('should process messages from client', () => {
      const input = 'This is a testing.';
      expect(client.send(codec.encode(input))).toBe(true);
      expect(channel.process()).toBe(1);
      expect(handler).toHaveBeenCalledWith(input);
    });
  });

  describe('blockingProcess', () => {
    it('should return 0 if timeout without message', () => {
      expect(channel.blockingProcess(10)).toBe(0);
    });

    it('should process messages from client', () => {
      const input = 'This is a testing.';
      expect(client.send(codec.encode(input))).toBe(true);
      expect(channel.blockingProcess()).toBe(1);
      expect(handler).toHaveBeenCalledWith(input);
    });
  });

  describe('pollAsync', () => {
    it('should process messages from client', async () => {
      const input = 'This is a testing.';
      expect(client.send(codec.encode(input))).toBe(true);
      await delay(10);
      expect(handler).toHaveBeenCalledWith(input);
    });
  });

  describe('flush', () => {
    it('should wait for channel to be flushed', async () => {
      const garbage = new Uint8Array(channel.maxSendSize + 100);
      channel['channel'].send(garbage);
      expect(channel.send('test')).toBe(false);
      new Worker(`
        const { workerData } = require('node:worker_threads');
        const state = new Int32Array(workerData.recv[0], workerData.recv[1], 16);
        setTimeout(() => {
          for (let i = 0; i < 4; ++i) {
            Atomics.store(state, i, 0);
          }
          Atomics.notify(state, 0);
        }, 200);
      `, {
        eval: true,
        workerData: channel.buffers
      });
      await delay(100);
      expect(channel.flush(1000)).toBe(true);
    });

    it('should return false on timeout', () => {
      const garbage = new Uint8Array(client.maxSendSize + 100);
      channel['channel'].send(garbage);
      expect(channel.flush(10)).toBe(false);
    });
  });

  describe('flushAsync', () => {
    it('should wait for channel to be flushed', async () => {
      const garbage = new Uint8Array(channel.maxSendSize + 100);
      channel['channel'].send(garbage);

      const flush = channel.flushAsync();
      client.receive();
      expect(await flush).toBe(true);
    });

    it('should return false on timeout', async () => {
      const garbage = new Uint8Array(channel.maxSendSize + 100);
      channel['channel'].send(garbage);
      expect(await channel.flushAsync(10)).toBe(false);
    });
  });
});
