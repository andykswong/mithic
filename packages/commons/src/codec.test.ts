import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { IdentityCodec, TextCodec, type Decoder, type Encoder } from './index.ts';

describe('Encoder', () => {
  it('should be compatible with TextEncoder', () => {
    const _: Encoder<string> = new TextEncoder();
  });
});

describe('Decoder', () => {
  it('should be compatible with TextDecoder', () => {
    const _: Decoder<string> = new TextDecoder();
  });
});

describe('TextCodec', () => {
  let codec: TextCodec;

  beforeEach(() => {
    codec = new TextCodec();
  })

  describe('encode', () => {
    it('should return string encoded', () => {
      const str = 'abc';
      const encodedStr = new TextEncoder().encode(str);
      assert.deepStrictEqual(codec.encode(str), encodedStr);
    });
  });

  describe('decode', () => {
    it('should return decoded string', () => {
      const str = 'testing';
      const encodedStr = new TextEncoder().encode(str);
      assert.deepStrictEqual(codec.decode(encodedStr), str);
    });
  });
});

describe('IdentityCodec', () => {
  describe('encode', () => {
    it('should return data unchanged', () => {
      const data = new Uint8Array([1, 2, 3]);
      assert.deepStrictEqual(IdentityCodec.encode(data), data);
    });
  });

  describe('decode', () => {
    it('should return data unchanged', () => {
      const data = new Uint8Array([4, 5]);
      assert.deepStrictEqual(IdentityCodec.decode(data), data);
    });
  });
});
