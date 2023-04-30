import { sha256 } from '@mithic/commons';
import { compareContentIds, compareBuffers, concatBuffers } from '../buffer.js';
import { CID } from 'multiformats';

describe('compareBuffers', () => {
  it('should return 0 when two arrays have same data and length', () => {
    const buffer1 = new Uint8Array([1, 2, 3]);
    const buffer2 = new Uint8Array([1, 2, 3]);
    expect(compareBuffers(buffer1, buffer2)).toBe(0);
  });

  it('should return -1 when first array is shorter than second', () => {
    const buffer1 = new Uint8Array([1, 2]);
    const buffer2 = new Uint8Array([1, 2, 3]);
    expect(compareBuffers(buffer1, buffer2)).toBe(-1);
  });

  it('should return 1 when first array is longer than second', () => {
    const buffer1 = new Uint8Array([1, 2, 3]);
    const buffer2 = new Uint8Array([1, 2]);
    expect(compareBuffers(buffer1, buffer2)).toBe(1);
  });

  it('should return correct value when both arrays have same length but different data', () => {
    const buffer1 = new Uint8Array([1, 2, 3]);
    const buffer2 = new Uint8Array([1, 3, 3]);
    expect(compareBuffers(buffer1, buffer2)).toBe(-1);
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
  it('should return 0 when two CIDs are the same', () => {
    const cid1 = CID.createV1(0, sha256.digest(new Uint8Array([1, 2, 3])));
    const cid2 = CID.createV1(0, sha256.digest(new Uint8Array([1, 2, 3])));
    expect(compareContentIds(cid1, cid2)).toBe(0);
  });

  it('should return -1 when first CID is less than second', () => {
    const cid1 = CID.createV1(0, sha256.digest(new Uint8Array([1, 2, 3])));
    const cid2 = CID.createV1(0, sha256.digest(new Uint8Array([1, 2, 4])));
    expect(compareContentIds(cid1, cid2)).toBe(-1);
  });
});
