import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { AtomicRingBuffer } from './index.ts';

describe('AtomicRingBuffer', () => {
  let buffer: AtomicRingBuffer;
  let state: Int32Array;
  let data: Uint8Array;

  beforeEach(() => {
    const sab = new SharedArrayBuffer(22);
    state = new Int32Array(sab, 0, 4);
    data = new Uint8Array(sab, 16);
    buffer = new AtomicRingBuffer(sab);
  });

  describe('byteLength', () => {
    it('should return 0 initially', () => {
      assert.strictEqual(buffer.byteLength, 0);
      assert.strictEqual(buffer.length, 0);
    });

    it('should return the size of the data', () => {
      buffer.push(new Uint8Array(3));
      assert.strictEqual(buffer.byteLength, 3);
      assert.strictEqual(buffer.length, 3);
    });
  });

  describe('maxByteLength', () => {
    it('should return the size of underlying buffer', () => {
      assert.strictEqual(buffer.maxByteLength, data.byteLength);
    });
  });

  describe('push', () => {
    it('should push data to the buffer', () => {
      const input = new Uint8Array([1, 2, 3]);
      assert.strictEqual(buffer.push(input), input.byteLength);
      assert.strictEqual(buffer.byteLength, 3);
      assert.deepStrictEqual(Array.from(data), [...input, 0, 0, 0]);
      assert.deepStrictEqual([...buffer], [...input]);
    });

    it('should push data to the buffer with wrapping', () => {
      buffer.push(new Uint8Array([0, 0, 0, 1, 2]));
      buffer.shift(new Uint8Array(3));

      const input = new Uint8Array([3, 4, 5]);
      assert.strictEqual(buffer.push(input), input.byteLength);
      assert.strictEqual(buffer.byteLength, 5);
      assert.deepStrictEqual(Array.from(data), [4, 5, 0, 1, 2, 3]);
      assert.deepStrictEqual([...buffer], [1, 2, 3, 4, 5]);
    });

    it('should return 0 if buffer is full', () => {
      const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      assert.deepStrictEqual(buffer.push(input), 0);
      assert.strictEqual(buffer.byteLength, 0);
    });
  });

  describe('shift', () => {
    it('should pop all data from the buffer by default', () => {
      buffer.push(new Uint8Array([0, 1, 2, 3]));
      buffer.shift(new Uint8Array(1));

      assert.deepStrictEqual(buffer.shift(), new Uint8Array([1, 2, 3]));
      assert.strictEqual(buffer.byteLength, 0);
    });

    it('should pop given data length from the buffer with wrapping', () => {
      const content = new Uint8Array([1, 2, 3, 4, 5]);
      buffer.push(new Uint8Array(4));
      buffer.shift();
      buffer.push(content);

      assert.deepStrictEqual(buffer.shift(new Uint8Array(3)), content.subarray(0, 3));
      assert.strictEqual(buffer.byteLength, 2);
      assert.deepStrictEqual([...buffer], [4, 5]);
    });

    it('should return undefined for empty pops', () => {
      assert.strictEqual(buffer.shift(new Uint8Array(1)), undefined);
      assert.strictEqual(buffer.shift(new Uint8Array(0)), undefined);
    });
  });

  describe('waitAsync', () => {
    it('should wait for length to change', async () => {
      const promise = buffer.waitAsync(3000);
      setTimeout(() => buffer.push(new Uint8Array([1])), 200);
      assert.strictEqual(buffer.byteLength, 0);
      assert.strictEqual(await promise, true);
      assert.strictEqual(buffer.byteLength, 1);
    });
  });

  describe('wait', () => {
    it('should wait for length to change', () => {
      new Worker(`
        const { workerData } = require('node:worker_threads');
        setTimeout(() => {
          Atomics.store(workerData.length, 0, 1);
          Atomics.notify(workerData.length, 0);
        }, 200);
      `, {
        eval: true,
        workerData: { length: state }
      });
      assert.strictEqual(buffer.byteLength, 0);
      assert.strictEqual(buffer.wait(3000), true);
      assert.strictEqual(buffer.byteLength, 1);
    });
  });
});
