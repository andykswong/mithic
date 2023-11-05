import { describe, expect, it } from '@jest/globals';
import { CID } from 'multiformats';
import { sha256 } from 'multiformats/hashes/sha2';
import { compareContentIds, compareBuffers, concatBuffers } from '../buffer.js';

describe('compareBuffers', () => {
  it('should return 0 when two buffers have same data and length', () => {
    const buffer1 = new Uint8Array([1, 2, 3]);
    const buffer2 = new Uint8Array([1, 2, 3]);
    expect(compareBuffers(buffer1, buffer2)).toBe(0);
  });

  it('should return -1 when both buffers have same length but first is lexicographically smaller', () => {
    const buffer1 = Uint8Array.from([1, 2, 3]);
    const buffer2 = Uint8Array.from([1, 2, 4]);
    expect(compareBuffers(buffer1, buffer2)).toBe(-1);
  });

  it('should return -1 for a smaller buffer compared to a larger buffer', () => {
    const buffer1 = Uint8Array.from([1, 2, 3]);
    const buffer2 = Uint8Array.from([1, 2, 3, 4]);
    expect(compareBuffers(buffer1, buffer2)).toBe(-1);
  });

  it('should return -1 for a larger buffer that is lexicographically smaller compared to a smaller buffer', () => {
    const buffer1 = new Uint8Array([1, 2, 3]);
    const buffer2 = new Uint8Array([1, 3]);
    expect(compareBuffers(buffer1, buffer2)).toBe(-1);
  });

  it('should return 1 for a larger buffer compared to a smaller buffer', () => {
    const buffer1 = Uint8Array.from([1, 2, 3, 4]);
    const buffer2 = Uint8Array.from([1, 2, 3]);
    expect(compareBuffers(buffer1, buffer2)).toBe(1);
  });

  it('should return 1 for a smaller buffer that is lexicographically larger compared to a larger buffer', () => {
    const buffer1 = new Uint8Array([1, 3, 7]);
    const buffer2 = new Uint8Array([1, 2, 3, 4]);
    expect(compareBuffers(buffer1, buffer2)).toBe(1);
  });

  it('should return 1 when both buffers have same length but first is lexicographically larger', () => {
    const buffer1 = Uint8Array.from([1, 3, 7]);
    const buffer2 = Uint8Array.from([1, 2, 4]);
    expect(compareBuffers(buffer1, buffer2)).toBe(1);
  });
});

describe('concatBuffers', () => {
  it('should concatenate two Uint8Arrays', () => {
    const arr1 = Uint8Array.from([1, 2, 3]);
    const arr2 = Uint8Array.from([4, 5, 6]);
    const result = concatBuffers(arr1, arr2);
    expect(result).toEqual(Uint8Array.from([1, 2, 3, 4, 5, 6]));
  });

  it('should concatenate three Uint8Arrays', () => {
    const arr1 = Uint8Array.from([1, 2]);
    const arr2 = Uint8Array.from([3, 4, 5]);
    const arr3 = Uint8Array.from([6]);
    const result = concatBuffers(arr1, arr2, arr3);
    expect(result).toEqual(Uint8Array.from([1, 2, 3, 4, 5, 6]));
  });

  it('should concatenate zero Uint8Arrays', () => {
    const result = concatBuffers();
    expect(result).toEqual(Uint8Array.from([]));
  });
});

describe('compareContentIds', () => {
  it('should return 0 when two CIDs are the same', async () => {
    const cid1 = CID.createV1(0, await sha256.digest(new Uint8Array([1, 2, 3])));
    const cid2 = CID.createV1(0, await sha256.digest(new Uint8Array([1, 2, 3])));
    expect(compareContentIds(cid1, cid2)).toBe(0);
  });

  it('should return -1 when first CID is less than second', async () => {
    const cid1 = CID.createV1(0, await sha256.digest(new Uint8Array([1, 2, 3])));
    const cid2 = CID.createV1(0, await sha256.digest(new Uint8Array([1, 2, 4])));
    expect(compareContentIds(cid1, cid2)).toBe(-1);
  });
});
