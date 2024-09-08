import { Worker } from 'node:worker_threads';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { AtomicRingBuffer } from '../buffer.ts';

describe(AtomicRingBuffer.name, () => {
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
      expect(buffer.byteLength).toBe(0);
      expect(buffer.length).toBe(0);
    });

    it('should return the size of the data', () => {
      buffer.push(new Uint8Array(3));
      expect(buffer.byteLength).toBe(3);
      expect(buffer.length).toBe(3);
    });
  });

  describe('maxByteLength', () => {
    it('should return the size of underlying buffer', () => {
      expect(buffer.maxByteLength).toBe(data.byteLength);
    });
  });

  describe('push', () => {
    it('should push data to the buffer', () => {
      const input = new Uint8Array([1, 2, 3]);
      expect(buffer.push(input)).toBe(input.byteLength);
      expect(buffer.byteLength).toBe(3);
      expect(Array.from(data)).toEqual([...input, 0, 0, 0]);
      expect([...buffer]).toEqual([...input]);
    });

    it('should push data to the buffer with wrapping', () => {
      buffer.push(new Uint8Array([0, 0, 0, 1, 2]));
      buffer.shift(new Uint8Array(3));

      const input = new Uint8Array([3, 4, 5]);
      expect(buffer.push(input)).toBe(input.byteLength);
      expect(buffer.byteLength).toBe(5);
      expect(Array.from(data)).toEqual([4, 5, 0, 1, 2, 3]);
      expect([...buffer]).toEqual([1, 2, 3, 4, 5]);
    });

    it('should return 0 if buffer is full', () => {
      const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(buffer.push(input)).toEqual(0);
      expect(buffer.byteLength).toBe(0);
    });
  });

  describe('shift', () => {
    it('should pop all data from the buffer by default', () => {
      buffer.push(new Uint8Array([0, 1, 2, 3]));
      buffer.shift(new Uint8Array(1));

      expect(buffer.shift()).toEqual(new Uint8Array([1, 2, 3]));
      expect(buffer.byteLength).toBe(0);
    });

    it('should pop given data length from the buffer with wrapping', () => {
      const content = new Uint8Array([1, 2, 3, 4, 5]);
      buffer.push(new Uint8Array(4));
      buffer.shift();
      buffer.push(content);

      expect(buffer.shift(new Uint8Array(3))).toEqual(content.subarray(0, 3));
      expect(buffer.byteLength).toBe(2);
      expect([...buffer]).toEqual([4, 5]);
    });

    it('should return undefined for empty pops', () => {
      expect(buffer.shift(new Uint8Array(1))).toBeUndefined();
      expect(buffer.shift(new Uint8Array(0))).toBeUndefined();
    })
  });

  describe('waitAsync', () => {
    it('should wait for length to change', async () => {
      const promise = buffer.waitAsync(3000);
      setTimeout(() => buffer.push(new Uint8Array([1])), 200);
      expect(buffer.byteLength).toBe(0);
      expect(await promise).toBe(true);
      expect(buffer.byteLength).toBe(1);
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
      expect(buffer.byteLength).toBe(0);
      expect(buffer.wait(3000)).toBe(true);
      expect(buffer.byteLength).toBe(1);
    });
  });
});
