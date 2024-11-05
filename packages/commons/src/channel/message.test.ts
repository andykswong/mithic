import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock, type Mock } from 'node:test';
import { Worker } from 'node:worker_threads';
import { TextCodec } from '../codec.ts';
import { dispose } from '../lifecycle.ts';
import { delay } from '../async/index.ts';
import { SharedArrayBufferChannel } from './buffer.ts';
import { SyncMessageChannel } from './message.ts';

describe('SyncMessageChannel', () => {
  let channel: SyncMessageChannel<string>;
  let codec: TextCodec;
  let client: SharedArrayBufferChannel;
  let handler: Mock<(message: string) => void>;

  beforeEach(() => {
    codec = new TextCodec();
    handler = mock.fn();
    channel = new SyncMessageChannel({ codec, onmessage: handler, receiver: true });
    client = new SharedArrayBufferChannel(channel.buffers);
  });

  afterEach(() => {
    dispose(channel);
  });

  it('should start by default', () => {
    assert.strictEqual(channel.started, true);
  });

  describe('send', () => {
    it('should send messages to channel', () => {
      const input = 'This is a message.';
      assert.strictEqual(channel.send(input), true);
      const result = client.receive();
      assert.strictEqual(codec.decode(result!), input);
    });
  });

  describe('sendAsync', () => {
    it('should send messages to channel', async () => {
      const input = 'This is a reply!';
      assert.strictEqual(await channel.sendAsync(input), true);
      const result = client.receive();
      assert.strictEqual(codec.decode(result!), input);
    });

    it('should wait for channel to be flushed', async () => {
      const garbage = new Uint8Array(channel.maxSendSize);
      channel['channel'].send(garbage);

      const input = 'This is a reply!';
      assert.strictEqual(await channel.sendAsync(input, 0), false);
      const pendingSend = channel.sendAsync(input);
      client.receive();
      assert.strictEqual(await pendingSend, true);
    });
  });

  describe('receive', () => {
    it('should return undefined if there is no message to process', () => {
      assert.strictEqual(channel.receive(), undefined);
    });

    it('should return message from client', () => {
      const input = 'This is a testing.';
      assert.strictEqual(client.send(codec.encode(input)), true);
      assert.strictEqual(channel.receive(), input);
      assert.deepStrictEqual(handler.mock.calls[0].arguments, [input]);
    });
  });

  describe('process', () => {
    it('should return 0 if there is no message to process', () => {
      assert.strictEqual(channel.process(), 0);
    });

    it('should process messages from client', () => {
      const input = 'This is a testing.';
      assert.strictEqual(client.send(codec.encode(input)), true);
      assert.strictEqual(channel.process(), 1);
      assert.deepStrictEqual(handler.mock.calls[0].arguments, [input]);
    });
  });

  describe('blockingProcess', () => {
    it('should return 0 if timeout without message', () => {
      assert.strictEqual(channel.blockingProcess(10), 0);
    });

    it('should process messages from client', () => {
      const input = 'This is a testing.';
      assert.strictEqual(client.send(codec.encode(input)), true);
      assert.strictEqual(channel.blockingProcess(), 1);
      assert.deepStrictEqual(handler.mock.calls[0].arguments, [input]);
    });
  });

  describe('pollAsync', () => {
    it('should process messages from client', async () => {
      const input = 'This is a testing.';
      assert.strictEqual(client.send(codec.encode(input)), true);
      await delay(1000);
      assert.deepStrictEqual(handler.mock.calls[0].arguments, [input]);
    });
  });

  describe('flush', () => {
    it('should wait for channel to be flushed', async () => {
      const garbage = new Uint8Array(channel.maxSendSize + 100);
      channel['channel'].send(garbage);
      assert.strictEqual(channel.send('test'), false);
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
      assert.strictEqual(channel.flush(1000), true);
    });

    it('should return false on timeout', () => {
      const garbage = new Uint8Array(client.maxSendSize + 100);
      channel['channel'].send(garbage);
      assert.strictEqual(channel.flush(10), false);
    });
  });

  describe('flushAsync', () => {
    it('should wait for channel to be flushed', async () => {
      const garbage = new Uint8Array(channel.maxSendSize + 100);
      channel['channel'].send(garbage);

      const flush = channel.flushAsync();
      client.receive();
      assert.strictEqual(await flush, true);
    });

    it('should return false on timeout', async () => {
      setTimeout(() => {}, 100); // workaround for 'Promise resolution is still pending' error with Atomics.waitAsync

      const garbage = new Uint8Array(channel.maxSendSize + 100);
      channel['channel'].send(garbage);
      assert.strictEqual(await channel.flushAsync(10), false);
    });
  });
});
