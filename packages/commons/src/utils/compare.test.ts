import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arrayCompare } from './index.ts';

describe('arrayCompare', () => {
  it('should return 0 when two buffers have same data and length', () => {
    const buffer1 = new Uint8Array([1, 2, 3]);
    const buffer2 = new Uint8Array([1, 2, 3]);
    assert.strictEqual(arrayCompare(buffer1, buffer2), 0);
  });

  it('should work for bigint array', () => {
    const buffer1 = BigInt64Array.from([1n, 2n, 3n]);
    const buffer2 = BigInt64Array.from([1n, 2n, 4n]);
    assert.strictEqual(arrayCompare(buffer1, buffer2), -1);
  });

  it('should return -1 when both buffers have same length but first is lexicographically smaller', () => {
    const buffer1 = Uint8Array.from([1, 2, 3]);
    const buffer2 = Uint8Array.from([1, 2, 4]);
    assert.strictEqual(arrayCompare(buffer1, buffer2), -1);
  });

  it('should return -1 for a smaller buffer compared to a larger buffer', () => {
    const buffer1 = Uint8Array.from([1, 2, 3]);
    const buffer2 = Uint8Array.from([1, 2, 3, 4]);
    assert.strictEqual(arrayCompare(buffer1, buffer2), -1);
  });

  it('should return -1 for a larger buffer that is lexicographically smaller compared to a smaller buffer', () => {
    const buffer1 = new Uint8Array([1, 2, 3]);
    const buffer2 = new Uint8Array([1, 3]);
    assert.strictEqual(arrayCompare(buffer1, buffer2), -1);
  });

  it('should return 1 for a larger buffer compared to a smaller buffer', () => {
    const buffer1 = Uint8Array.from([1, 2, 3, 4]);
    const buffer2 = Uint8Array.from([1, 2, 3]);
    assert.strictEqual(arrayCompare(buffer1, buffer2), 1);
  });

  it('should return 1 for a smaller buffer that is lexicographically larger compared to a larger buffer', () => {
    const buffer1 = new Uint8Array([1, 3, 7]);
    const buffer2 = new Uint8Array([1, 2, 3, 4]);
    assert.strictEqual(arrayCompare(buffer1, buffer2), 1);
  });

  it('should return 1 when both buffers have same length but first is lexicographically larger', () => {
    const buffer1 = Uint8Array.from([1, 3, 7]);
    const buffer2 = Uint8Array.from([1, 2, 4]);
    assert.strictEqual(arrayCompare(buffer1, buffer2), 1);
  });
});
