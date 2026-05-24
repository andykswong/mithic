import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock, type Mock } from 'node:test';
import { symbolCabiLower } from '@mithic/commons';
import { random, insecure, insecureSeed } from './index.ts';

const MAX_BYTES = 65536;

describe('random', () => {
  const BYTES = [0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x01, 0x23];
  const U64 = 0xefcdab9078563412n;
  const BYTES2 = [0x45, 0x67, 0x89] as const;
  const U64_2 = 0x896745n;
  let getRandomValuesSpy: Mock<typeof crypto.getRandomValues>;

  beforeEach(() => {
    getRandomValuesSpy = mock.method(crypto, 'getRandomValues');
    getRandomValuesSpy.mock.mockImplementationOnce(((a: never) => getRandomValuesMock(BYTES, a)) as typeof crypto.getRandomValues, 0);
    getRandomValuesSpy.mock.mockImplementationOnce(((a: never) => getRandomValuesMock(BYTES2, a)) as typeof crypto.getRandomValues, 1);
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

    describe('cabiLower', () => {
      it('should return byte sequence from crypto.getRandomValues', () => {
        const ptr = 32;
        const realloc = mock.fn(() => ptr);
        const memory = new WebAssembly.Memory({ initial: 1 });
        const view = new DataView(memory.buffer);
        const getRandomBytes = random.getRandomBytes[symbolCabiLower]!({ memory, realloc, resourceTables: [] });

        getRandomBytes(BigInt(BYTES.length), 8);

        assert.strictEqual(view.getUint32(8, true), ptr);
        assert.strictEqual(view.getUint32(12, true), BYTES.length);
        assert.deepStrictEqual(Array.from(new Uint8Array(memory.buffer, ptr, BYTES.length)), BYTES);
      });
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

    describe('cabiLower', () => {
      it('should set u64 pair from crypto.getRandomValues to return pointer', () => {
        const memory = new WebAssembly.Memory({ initial: 1 });
        const view = new DataView(memory.buffer);
        const insecureSeedFn = insecureSeed.insecureSeed[symbolCabiLower]!({ memory, realloc: () => 0, resourceTables: [] });

        insecureSeedFn(8);

        assert.strictEqual(view.getBigUint64(8, true), U64);
        assert.strictEqual(view.getBigUint64(16, true), U64_2);
      });
    });
  });
});

function getRandomValuesMock<T extends Exclude<BufferSource, ArrayBuffer>>(val: readonly number[], array: T): T {
  const buffer = array as ArrayBufferView;
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    .fill(0)
    .set(val.slice(0, Math.min(val.length, buffer.byteLength)));
  return array;
}
