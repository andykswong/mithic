import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock, type Mock } from 'node:test';
import { random, insecure, insecureSeed } from './index.ts';

const MAX_BYTES = 65536;

describe('random', () => {
  const BYTES = [0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x01, 0x23];
  const U64 = 0xefcdab9078563412n;
  const BYTES2 = [0x45, 0x67, 0x89] as const;
  const U64_2 = 0x896745n;
  let getRandomValuesSpy: Mock<(buffer: ArrayBufferView | null) => ArrayBufferView | null>;

  beforeEach(() => {
    getRandomValuesSpy = mock.method(crypto, 'getRandomValues');
    getRandomValuesSpy.mock.mockImplementationOnce(getRandomValuesMock.bind(null, BYTES), 0);
    getRandomValuesSpy.mock.mockImplementationOnce(getRandomValuesMock.bind(null, BYTES2), 1);
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('getRandomBytes', () => {
    it('should return byte sequence from crypto.getRandomValues', () => {
      assert.deepStrictEqual(Array.from(random.getRandomBytes(BigInt(BYTES.length))), BYTES);
    });

    it('should call crypto.getRandomValues in chunks', () => {
      const len = MAX_BYTES + BYTES2.length * 2;
      const result = random.getRandomBytes(BigInt(len));
      assert.strictEqual(result.byteLength, len);
      assert.deepStrictEqual(Array.from(result.subarray(0, BYTES.length)), BYTES);
      assert.deepStrictEqual(Array.from(result.subarray(MAX_BYTES, MAX_BYTES + BYTES2.length)), BYTES2);
    });
  });

  describe('getRandomU64', () => {
    it('should return u64 from crypto.getRandomValues', () => {
      assert.strictEqual(random.getRandomU64(), U64);
    });
  });

  describe('getInsecureRandomBytes', () => {
    it('should return byte sequence from crypto.getRandomValues', () => {
      assert.deepStrictEqual(Array.from(insecure.getInsecureRandomBytes(BigInt(BYTES.length))), BYTES);
    });
  });

  describe('getInsecureRandomU64', () => {
    it('should return u64 from crypto.getRandomValues', () => {
      assert.strictEqual(insecure.getInsecureRandomU64(), U64);
    });
  });

  describe('insecureSeed', () => {
    it('should return u64 pair from crypto.getRandomValues', () => {
      assert.deepStrictEqual(insecureSeed.insecureSeed(), [U64, U64_2]);
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
