import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { AtomicRingBuffer } from '../buffer.ts';
import { SharedArrayBufferChannel } from './buffer.ts';

const SIZE_LEN = 4;

describe('SharedArrayBufferChannel', () => {
  let sendQueue: AtomicRingBuffer;
  let recvQueue: AtomicRingBuffer;
  let channel: SharedArrayBufferChannel;

  beforeEach(() => {
    sendQueue = new AtomicRingBuffer(new SharedArrayBuffer(30), 8, 22);
    recvQueue = new AtomicRingBuffer(new SharedArrayBuffer(40), 4);
    channel = new SharedArrayBufferChannel({ sendQueue, recvQueue });
  });

  describe('buffers', () => {
    it('should return the underlying buffers', () => {
      assert.deepStrictEqual(channel.buffers, {
        send: [sendQueue.buffer, sendQueue.byteOffset, sendQueue.maxByteLength],
        recv: [recvQueue.buffer, recvQueue.byteOffset, recvQueue.maxByteLength],
      });
    });
  });

  describe('bufferLength', () => {
    it('should return the free size of send buffer minus 4', () => {
      const input = new Uint8Array([1, 2, 3]);
      sendQueue.push(input);
      assert.strictEqual(channel.maxSendSize, sendQueue.maxByteLength - input.byteLength - SIZE_LEN);
    });
  });

  describe('send', () => {
    it('should push data to send queue', () => {
      const input = new Uint8Array([1, 2]);
      const header = getSizeHeader(input.byteLength);
      assert.strictEqual(channel.send(input), true);
      assert.strictEqual(sendQueue.byteLength, input.byteLength + SIZE_LEN);
      assert.deepStrictEqual([...sendQueue], [...header, ...input]);
    });

    it('should put data to buffer if send queue is full', () => {
      const input = new Uint8Array([1, 2, 3, 4, 5, 6]);
      assert.strictEqual(channel.send(input), true);
      assert.strictEqual(sendQueue.byteLength, 6);
      sendQueue.shift();
      assert.strictEqual(channel.maxSendSize, 6 - 4 - 4);
    });
  });

  describe('receive', () => {
    it('should pop message from receive buffer', () => {
      const LEN1 = 3;
      const content = new Uint8Array([1, 2, 3, 4, 5]);
      recvQueue.push(getSizeHeader(LEN1));
      recvQueue.push(content.subarray(0, LEN1));
      const HEADER2 = getSizeHeader(content.byteLength);
      recvQueue.push(HEADER2);
      recvQueue.push(content);

      const msg = channel.receive();
      assert.deepStrictEqual(msg, content.subarray(0, LEN1));

      assert.deepStrictEqual([...recvQueue], [...HEADER2, ...content]);

      const msg2 = channel.receive();
      assert.deepStrictEqual(msg2, content);
    });

    it('should return undefined for empty receive queue', () => {
      assert.strictEqual(channel.receive(), undefined);
    });
  });

  describe('waitAsync', () => {
    it('should wait for recv queue to have message', async () => {
      const promise = channel.waitAsync(3000);
      setTimeout(() => recvQueue.push(new Uint8Array([1])), 200);
      assert.strictEqual(await promise, true);
      assert.strictEqual(recvQueue.byteLength, 1);
    });

    it('should return immediate if recv queue has message', async () => {
      recvQueue.push(new Uint8Array([1]));
      assert.strictEqual(await channel.waitAsync(3000), true);
    });
  });

  describe('wait', () => {
    it('should wait for recv queue to have message', () => {
      new Worker(`
        const { workerData } = require('node:worker_threads');
        setTimeout(() => {
          Atomics.store(workerData.length, 0, 1);
          Atomics.notify(workerData.length, 0);
        }, 200);
      `, {
        eval: true,
        workerData: { length: new Int32Array(recvQueue.buffer, recvQueue.byteOffset, 1) }
      });
      assert.strictEqual(channel.wait(3000), true);
      assert.strictEqual(recvQueue.byteLength, 1);
    });

    it('should return immediate if recv queue has message', () => {
      recvQueue.push(new Uint8Array([1]));
      assert.strictEqual(channel.wait(3000), true);
    });
  });

  describe('flushAsync', () => {
    it('should wait for send buffer to be flushed', async () => {
      const content = new Uint8Array([1, 2, 3]);
      assert.strictEqual(channel.send(content), true);
      assert(channel.maxSendSize < 0);
      const promise = channel.flushAsync(3000);
      let chunk1;
      setTimeout(() => chunk1 = sendQueue.shift(), 200);
      assert.strictEqual(await promise, true);
      assert(channel.maxSendSize > 0);
      const chunk2 = sendQueue.shift();
      assert.deepStrictEqual([...(chunk1 || []), ...(chunk2 || [])], [...[content.byteLength, 0, 0, 0], ...content]);
    });

    it('should return immediate if send queue has no message', async () => {
      assert.strictEqual(await channel.flushAsync(3000), true);
    });
  });

  describe('flush', () => {
    it('should wait for send queue to be consumed', () => {
      const content = new Uint8Array([1, 2, 3]);
      assert.strictEqual(channel.send(content), true);
      assert(channel.maxSendSize < 0);
      new Worker(`
        const { workerData } = require('node:worker_threads');
        setTimeout(() => {
          for (let i = 0; i < 4; ++i) {
            Atomics.store(workerData.length, i, 0);
          }
          Atomics.notify(workerData.length, 0);
        }, 200);
      `, {
        eval: true,
        workerData: { length: new Int32Array(sendQueue.buffer, sendQueue.byteOffset, 4) }
      });
      assert.strictEqual(channel.flush(3000), true);
      assert(channel.maxSendSize > 0);
    });

    it('should return immediate if send queue has no message', () => {
      assert.strictEqual(channel.flush(3000), true);
    });
  });

  function getSizeHeader(size: number): Uint8Array {
    const sizeData = new Uint8Array(SIZE_LEN);
    new DataView(sizeData.buffer).setUint32(0, size, true);
    return sizeData;
  }
});
