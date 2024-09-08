import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getRandomBytes, getRandomU64 } from '../random.ts';
import { getInsecureRandomBytes, getInsecureRandomU64 } from '../insecure.ts';
import { insecureSeed } from '../insecure-seed.ts';

const MAX_BYTES = 65536;

describe('random', () => {
  const BYTES = [0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x01, 0x23];
  const U64 = 0xefcdab9078563412n;
  const BYTES2 = [0x45, 0x67, 0x89] as const;
  const U64_2 = 0x896745n;
  let getRandomValuesSpy: jest.SpiedFunction<typeof crypto.getRandomValues>;

  beforeEach(() => {
    getRandomValuesSpy = jest.spyOn(crypto, 'getRandomValues');
    getRandomValuesSpy
      .mockImplementationOnce(getRandomValuesMock.bind(null, BYTES))
      .mockImplementationOnce(getRandomValuesMock.bind(null, BYTES2));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getRandomBytes', () => {
    it('should return byte sequence from crypto.getRandomValues', () => {
      expect(Array.from(getRandomBytes(BigInt(BYTES.length)))).toStrictEqual(BYTES);
    });

    it('should call crypto.getRandomValues in chunks', () => {
      const len = MAX_BYTES + BYTES2.length * 2;
      const result = getRandomBytes(BigInt(len));
      expect(result.byteLength).toBe(len);
      expect(Array.from(result.subarray(0, BYTES.length))).toStrictEqual(BYTES);
      expect(Array.from(result.subarray(MAX_BYTES, MAX_BYTES + BYTES2.length))).toStrictEqual(BYTES2);
    });
  });

  describe('getRandomU64', () => {
    it('should return u64 from crypto.getRandomValues', () => {
      expect(getRandomU64()).toBe(U64);
    });
  });

  describe('getInsecureRandomBytes', () => {
    it('should return byte sequence from crypto.getRandomValues', () => {
      expect(Array.from(getInsecureRandomBytes(BigInt(BYTES.length)))).toStrictEqual(BYTES);
    });
  });

  describe('getInsecureRandomU64', () => {
    it('should return u64 from crypto.getRandomValues', () => {
      expect(getInsecureRandomU64()).toBe(U64);
    });
  });

  describe('insecureSeed', () => {
    it('should return u64 pair from crypto.getRandomValues', () => {
      expect(insecureSeed()).toStrictEqual([U64, U64_2]);
    });
  });
});

function getRandomValuesMock(val: readonly number[], buffer: ArrayBufferView | null) {
  if (buffer) {
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      .fill(0)
      .set(val.slice(0, Math.min(val.length, buffer.byteLength)));
  }
  return buffer;
}
